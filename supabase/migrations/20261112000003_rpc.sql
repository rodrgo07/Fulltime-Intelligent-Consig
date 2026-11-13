-- Funções expostas pela API (contrato v1 — ver docs/API_CONTRACT.md).
-- Todas: security definer, search_path vazio, verificação explícita de papel.
-- Erros: SQLSTATE P0001 com message = código estável (ex.: RATE_LIMITED).

-- ============================================================ operador
create function public.submit_proposal_request(
  p_idempotency_key uuid,
  p_form_version integer,
  p_payload jsonb,
  p_owner_operator_id uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_role('operator');
  v_owner uuid := coalesce(p_owner_operator_id, v_uid);
  v_form public.form_definitions;
  v_errors jsonb;
  v_fp text;
  v_existing public.proposal_requests;
  v_req public.proposal_requests;
  v_ttl interval := make_interval(hours => private.setting_int('pii_ttl_hours'));
begin
  if p_idempotency_key is null then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  -- Reenvio da mesma requisição (retry de rede / replay): devolve o registro existente, sem duplicar.
  select * into v_existing from public.proposal_requests
   where submitted_by = v_uid and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('request_id', v_existing.id, 'public_ref', v_existing.public_ref,
                              'status', v_existing.status, 'duplicate', true);
  end if;

  if not exists (select 1 from public.operators where id = v_uid) then
    raise exception using errcode = 'P0001', message = 'NOT_AN_OPERATOR';
  end if;

  -- Regra atual: proprietário do cliente = remetente. Para liberar, trocar esta verificação
  -- por "proprietário é operador ativo" (ver docs/DEVELOPMENT_ROADMAP.md).
  if v_owner <> v_uid then
    raise exception using errcode = 'P0001', message = 'OWNER_NOT_ALLOWED';
  end if;

  if octet_length(p_payload::text) > private.setting_int('payload_max_bytes') then
    raise exception using errcode = 'P0001', message = 'PAYLOAD_TOO_LARGE';
  end if;

  select * into v_form from public.form_definitions where active;
  if not found then
    raise exception using errcode = 'P0001', message = 'FORM_NOT_CONFIGURED';
  end if;
  if v_form.version <> p_form_version then
    raise exception using errcode = 'P0001', message = 'FORM_VERSION_OUTDATED',
      detail = v_form.version::text;
  end if;

  v_errors := private.validate_payload(v_form.fields, p_payload);
  if jsonb_array_length(v_errors) > 0 then
    raise exception using errcode = 'P0001', message = 'PAYLOAD_INVALID', detail = v_errors::text;
  end if;

  if (select count(*) from public.proposal_requests
       where submitted_by = v_uid and received_at > now() - interval '1 minute')
     >= private.setting_int('rate_limit_per_minute')
  or (select count(*) from public.proposal_requests
       where submitted_by = v_uid and received_at > now() - interval '1 day')
     >= private.setting_int('rate_limit_per_day') then
    perform private.audit('request.rate_limited', null, '{}'::jsonb);
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;

  -- Mesmo cliente enviado de novo com outra chave enquanto o anterior ainda está em andamento.
  v_fp := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  select * into v_existing from public.proposal_requests
   where submitted_by = v_uid and payload_fingerprint = v_fp
     and status not in ('completed', 'failed', 'cancelled');
  if found then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_REQUEST', detail = v_existing.public_ref;
  end if;

  insert into public.proposal_requests
    (submitted_by, owner_operator_id, idempotency_key, payload_fingerprint, form_version, pii_expires_at)
  values (v_uid, v_owner, p_idempotency_key, v_fp, v_form.version, now() + v_ttl)
  returning * into v_req;

  insert into public.clients_temp (request_id, payload, expires_at)
  values (v_req.id, p_payload, v_req.pii_expires_at);

  perform private.audit('request.received', v_req.id,
    jsonb_build_object('form_version', v_form.version, 'owner_is_submitter', v_owner = v_uid));

  return jsonb_build_object('request_id', v_req.id, 'public_ref', v_req.public_ref,
                            'status', v_req.status, 'duplicate', false);
end $$;

create function public.cancel_proposal_request(p_request_id uuid, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_role('operator');
  v_req public.proposal_requests;
begin
  select * into v_req from public.proposal_requests where id = p_request_id for update;
  if not found or v_req.submitted_by <> v_uid then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND';
  end if;
  if v_req.status not in ('received', 'queued') then
    raise exception using errcode = 'P0001', message = 'NOT_CANCELLABLE';
  end if;
  update public.proposal_requests set status = 'cancelled', status_reason = left(p_reason, 500)
   where id = p_request_id;
  perform private.purge_request_pii(p_request_id, 'cancelled');
  perform private.audit('request.cancelled', p_request_id, jsonb_build_object('by', 'operator'));
  return jsonb_build_object('request_id', p_request_id, 'status', 'cancelled');
end $$;

-- Indica aos operadores se o backoffice está conectado (sem expor detalhes internos).
create function public.backoffice_presence() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select max(last_seen_at) from public.app_versions where auth.uid() is not null
$$;

-- ============================================================ retenção (interna)
create function private.purge_request_pii(p_request_id uuid, p_reason text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_deleted integer;
begin
  delete from public.clients_temp where request_id = p_request_id;
  get diagnostics v_deleted = row_count;
  update public.proposal_requests
     set pii_purged_at = coalesce(pii_purged_at, now()), payload_fingerprint = null
   where id = p_request_id;
  if v_deleted > 0 then
    perform private.audit('pii.purged', p_request_id, jsonb_build_object('reason', p_reason));
  end if;
  return v_deleted > 0;  -- idempotente: segunda chamada não faz nada
end $$;

-- ============================================================ backoffice
create function public.acknowledge_received_requests() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare v_count integer;
begin
  perform private.require_role('backoffice');
  with moved as (
    update public.proposal_requests set status = 'queued'
     where status = 'received' and pii_purged_at is null
    returning id
  )
  select count(*) into v_count from moved;
  if v_count > 0 then
    perform private.audit('requests.acknowledged', null, jsonb_build_object('count', v_count));
  end if;
  return v_count;
end $$;

-- Reserva a próxima solicitação (FIFO). Retorna null quando não há trabalho ou a sessão está ocupada.
create function public.claim_next_job(p_worker_id text, p_app_version text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_role('backoffice');
  v_req public.proposal_requests;
  v_job public.automation_jobs;
  v_payload jsonb;
  v_fields jsonb;
begin
  if exists (select 1 from public.proposal_requests
              where status in ('preparing', 'running', 'awaiting_confirmation')) then
    return null;
  end if;

  select * into v_req from public.proposal_requests
   where status = 'queued' and pii_purged_at is null
   order by received_at
   limit 1
   for update skip locked;
  if not found then return null; end if;

  select payload into v_payload from public.clients_temp where request_id = v_req.id;
  if v_payload is null then
    update public.proposal_requests set status = 'failed', status_reason = 'PII_MISSING' where id = v_req.id;
    return null;
  end if;
  select fields into v_fields from public.form_definitions where version = v_req.form_version;

  update public.proposal_requests set status = 'preparing', status_reason = null where id = v_req.id;

  insert into public.automation_jobs (request_id, attempt, worker_id, leased_by, app_version, lease_expires_at)
  values (v_req.id,
          coalesce((select max(attempt) from public.automation_jobs where request_id = v_req.id), 0) + 1,
          left(p_worker_id, 100), v_uid, left(p_app_version, 40),
          now() + make_interval(secs => private.setting_int('job_lease_seconds')))
  returning * into v_job;

  perform private.audit('job.claimed', v_req.id, jsonb_build_object('job_id', v_job.id, 'attempt', v_job.attempt));

  return jsonb_build_object(
    'job_id', v_job.id, 'request_id', v_req.id, 'public_ref', v_req.public_ref,
    'attempt', v_job.attempt, 'form_version', v_req.form_version, 'fields', v_fields,
    'payload', v_payload, 'lease_expires_at', v_job.lease_expires_at);
end $$;

create function private.open_job(p_job_id uuid) returns public.automation_jobs
language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.automation_jobs;
begin
  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'JOB_NOT_FOUND';
  end if;
  if v_job.status not in ('leased', 'running') then
    raise exception using errcode = 'P0001', message = 'JOB_NOT_ACTIVE', detail = v_job.status::text;
  end if;
  return v_job;
end $$;

create function public.heartbeat_job(p_job_id uuid, p_step text default null) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare v_until timestamptz := now() + make_interval(secs => private.setting_int('job_lease_seconds'));
begin
  perform private.require_role('backoffice');
  perform private.open_job(p_job_id);
  update public.automation_jobs
     set heartbeat_at = now(), lease_expires_at = v_until, current_step = coalesce(left(p_step, 100), current_step)
   where id = p_job_id;
  return v_until;
end $$;

create function public.mark_job_running(p_job_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.automation_jobs;
begin
  perform private.require_role('backoffice');
  v_job := private.open_job(p_job_id);
  if v_job.status = 'running' then return; end if;
  update public.automation_jobs set status = 'running' where id = p_job_id;
  update public.proposal_requests set status = 'running' where id = v_job.request_id;
  perform private.audit('job.running', v_job.request_id, jsonb_build_object('job_id', p_job_id));
end $$;

-- Marca o ponto sem retorno: a partir daqui uma falha nunca gera nova tentativa automática,
-- pois a proposta pode já ter sido criada no Consig.
create function public.mark_side_effect_started(p_job_id uuid, p_step text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.automation_jobs;
begin
  perform private.require_role('backoffice');
  v_job := private.open_job(p_job_id);
  update public.automation_jobs
     set side_effect_started_at = coalesce(side_effect_started_at, now()), current_step = left(p_step, 100)
   where id = p_job_id;
  perform private.audit('job.side_effect_started', v_job.request_id,
    jsonb_build_object('job_id', p_job_id, 'step', left(p_step, 100)));
end $$;

-- Grava resultado + notificação e apaga os dados pessoais NA MESMA TRANSAÇÃO.
-- Se qualquer etapa falhar, nada é apagado.
create function private.finalize_success(
  p_request_id uuid, p_job_id uuid, p_adhesion_number text, p_external_operation_id text,
  p_result_status text, p_source text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_req public.proposal_requests;
begin
  if coalesce(btrim(p_adhesion_number), '') = '' then
    raise exception using errcode = 'P0001', message = 'ADHESION_NUMBER_REQUIRED';
  end if;
  select * into v_req from public.proposal_requests where id = p_request_id for update;

  insert into public.proposal_results
    (request_id, job_id, adhesion_number, external_operation_id, result_status, completed_at, source, confirmed_by)
  values (p_request_id, p_job_id, btrim(p_adhesion_number), nullif(btrim(p_external_operation_id), ''),
          coalesce(nullif(btrim(p_result_status), ''), 'GERADA'), now(), p_source,
          case when p_source = 'manual' then auth.uid() end);

  update public.proposal_requests set status = 'completed', status_reason = null where id = p_request_id;

  insert into public.notification_queue (request_id, kind, recipient_operator_id)
  values (p_request_id, 'proposal_completed', v_req.owner_operator_id)
  on conflict (request_id, kind) do nothing;

  perform private.purge_request_pii(p_request_id, 'completed');
  perform private.audit('request.completed', p_request_id,
    jsonb_build_object('job_id', p_job_id, 'source', p_source));
  return jsonb_build_object('request_id', p_request_id, 'status', 'completed');
end $$;

create function public.complete_job(
  p_job_id uuid, p_adhesion_number text, p_external_operation_id text default null,
  p_result_status text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.automation_jobs;
begin
  perform private.require_role('backoffice');
  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'JOB_NOT_FOUND'; end if;
  -- Idempotente: repetir a chamada após sucesso devolve o mesmo resultado.
  if v_job.status = 'succeeded' then
    return jsonb_build_object('request_id', v_job.request_id, 'status', 'completed', 'duplicate', true);
  end if;
  if v_job.status <> 'running' then
    raise exception using errcode = 'P0001', message = 'JOB_NOT_ACTIVE', detail = v_job.status::text;
  end if;
  update public.automation_jobs set status = 'succeeded', finished_at = now() where id = p_job_id;
  return private.finalize_success(v_job.request_id, p_job_id, p_adhesion_number,
                                  p_external_operation_id, p_result_status, 'rpa');
end $$;

create function private.escalate(p_job public.automation_jobs, p_code text, p_message text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.automation_jobs
     set status = 'awaiting_confirmation', error_code = left(p_code, 64), error_message = left(p_message, 1000)
   where id = p_job.id;
  update public.proposal_requests set status = 'awaiting_confirmation', status_reason = left(p_code, 500)
   where id = p_job.request_id;
  perform private.audit('job.escalated', p_job.request_id,
    jsonb_build_object('job_id', p_job.id, 'code', left(p_code, 64)));
end $$;

create function public.fail_job(p_job_id uuid, p_error_code text, p_error_message text default null,
                                p_retryable boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.automation_jobs;
  v_next public.request_status;
begin
  perform private.require_role('backoffice');
  v_job := private.open_job(p_job_id);

  if v_job.side_effect_started_at is not null then
    perform private.escalate(v_job, p_error_code, p_error_message);
    return jsonb_build_object('request_id', v_job.request_id, 'status', 'awaiting_confirmation');
  end if;

  v_next := case when p_retryable and v_job.attempt < private.setting_int('job_max_attempts')
                 then 'queued' else 'failed' end;
  update public.automation_jobs
     set status = 'failed', finished_at = now(), error_code = left(p_error_code, 64),
         error_message = left(p_error_message, 1000)
   where id = p_job_id;
  update public.proposal_requests set status = v_next, status_reason = left(p_error_code, 500)
   where id = v_job.request_id;
  perform private.audit('job.failed', v_job.request_id,
    jsonb_build_object('job_id', p_job_id, 'code', left(p_error_code, 64), 'next', v_next));
  return jsonb_build_object('request_id', v_job.request_id, 'status', v_next);
end $$;

-- Motor pede intervenção humana (tela inesperada, IA sem confiança, sessão expirada no meio, etc.).
create function public.escalate_job(p_job_id uuid, p_reason_code text, p_message text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_role('backoffice');
  perform private.escalate(private.open_job(p_job_id), p_reason_code, p_message);
end $$;

-- Libera um job que ainda não produziu efeito (ex.: sessão do Consig expirou antes de começar).
create function public.release_job(p_job_id uuid, p_reason_code text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.automation_jobs;
begin
  perform private.require_role('backoffice');
  v_job := private.open_job(p_job_id);
  if v_job.side_effect_started_at is not null then
    raise exception using errcode = 'P0001', message = 'SIDE_EFFECT_STARTED';
  end if;
  update public.automation_jobs set status = 'released', finished_at = now(), error_code = left(p_reason_code, 64)
   where id = p_job_id;
  update public.proposal_requests set status = 'queued', status_reason = left(p_reason_code, 500)
   where id = v_job.request_id;
  perform private.audit('job.released', v_job.request_id, jsonb_build_object('job_id', p_job_id, 'code', p_reason_code));
end $$;

-- Decisão humana sobre uma solicitação aguardando confirmação.
create function public.resolve_awaiting_request(
  p_request_id uuid, p_resolution text, p_adhesion_number text default null,
  p_result_status text default null, p_note text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_req public.proposal_requests;
  v_job public.automation_jobs;
begin
  perform private.require_role('backoffice');
  select * into v_req from public.proposal_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  if v_req.status <> 'awaiting_confirmation' then
    raise exception using errcode = 'P0001', message = 'NOT_AWAITING_CONFIRMATION';
  end if;
  select * into v_job from public.automation_jobs
   where request_id = p_request_id and status = 'awaiting_confirmation' for update;

  if p_resolution = 'completed' then
    update public.automation_jobs set status = 'succeeded', finished_at = now() where id = v_job.id;
    perform private.audit('request.resolved', p_request_id, jsonb_build_object('resolution', 'completed'));
    return private.finalize_success(p_request_id, v_job.id, p_adhesion_number, null, p_result_status, 'manual');
  elsif p_resolution in ('requeue', 'failed') then
    if p_resolution = 'requeue' and v_req.pii_purged_at is not null then
      raise exception using errcode = 'P0001', message = 'PII_EXPIRED';
    end if;
    update public.automation_jobs set status = 'failed', finished_at = now() where id = v_job.id;
    update public.proposal_requests
       set status = case p_resolution when 'requeue' then 'queued' else 'failed' end::public.request_status,
           status_reason = left(coalesce(p_note, 'RESOLVED_BY_BACKOFFICE'), 500)
     where id = p_request_id;
    perform private.audit('request.resolved', p_request_id, jsonb_build_object('resolution', p_resolution));
    return jsonb_build_object('request_id', p_request_id,
                              'status', case p_resolution when 'requeue' then 'queued' else 'failed' end);
  end if;
  raise exception using errcode = 'P0001', message = 'INVALID_RESOLUTION';
end $$;

create function public.requeue_failed_request(p_request_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_req public.proposal_requests;
begin
  perform private.require_role('backoffice');
  select * into v_req from public.proposal_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  if v_req.status <> 'failed' then raise exception using errcode = 'P0001', message = 'NOT_FAILED'; end if;
  if v_req.pii_purged_at is not null then raise exception using errcode = 'P0001', message = 'PII_EXPIRED'; end if;
  update public.proposal_requests set status = 'queued', status_reason = 'REQUEUED' where id = p_request_id;
  perform private.audit('request.requeued', p_request_id, '{}'::jsonb);
end $$;

create function public.cancel_request_backoffice(p_request_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_req public.proposal_requests;
begin
  perform private.require_role('backoffice');
  select * into v_req from public.proposal_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  if v_req.status not in ('received', 'queued', 'awaiting_confirmation', 'failed') then
    raise exception using errcode = 'P0001', message = 'NOT_CANCELLABLE';
  end if;
  update public.automation_jobs set status = 'cancelled', finished_at = now()
   where request_id = p_request_id and status = 'awaiting_confirmation';
  if v_req.status = 'failed' then
    -- failed -> cancelled não é transição válida; apenas descarta os dados.
    perform private.purge_request_pii(p_request_id, 'discarded');
  else
    update public.proposal_requests set status = 'cancelled', status_reason = left(p_reason, 500)
     where id = p_request_id;
    perform private.purge_request_pii(p_request_id, 'cancelled');
  end if;
  perform private.audit('request.cancelled', p_request_id, jsonb_build_object('by', 'backoffice'));
end $$;

create function public.report_backoffice_heartbeat(p_app_version text, p_channel text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.require_role('backoffice');
begin
  insert into public.app_versions (version, channel, last_reported_by)
  values (p_app_version, p_channel, v_uid)
  on conflict (version, channel) do update set last_seen_at = now(), last_reported_by = v_uid;
end $$;

create function public.storage_usage() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_staff() then raise exception using errcode = 'P0001', message = 'FORBIDDEN'; end if;
  return jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'limit_bytes', private.setting_int('storage_limit_bytes'),
    'tables', (select jsonb_object_agg(c.relname, pg_total_relation_size(c.oid))
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r'),
    'pii_rows', (select count(*) from public.clients_temp));
end $$;

-- ============================================================ admin
create function public.admin_set_member_active(p_profile_id uuid, p_active boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.require_role('admin');
begin
  if p_profile_id = v_uid then raise exception using errcode = 'P0001', message = 'CANNOT_CHANGE_SELF'; end if;
  update public.profiles set active = p_active where id = p_profile_id;
  if not found then raise exception using errcode = 'P0001', message = 'NOT_FOUND'; end if;
  if not p_active then
    -- Revoga refresh tokens; tokens de acesso restantes já são barrados por profiles.active.
    begin
      delete from auth.sessions where user_id = p_profile_id;
    exception when insufficient_privilege then
      perform private.audit('member.session_revoke_failed', null, jsonb_build_object('profile_id', p_profile_id));
    end;
  end if;
  perform private.audit(case when p_active then 'member.activated' else 'member.deactivated' end, null,
                        jsonb_build_object('profile_id', p_profile_id));
end $$;

-- Usada pela Edge Function admin-invite (com o JWT do admin) antes de convidar.
create function public.assert_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role('admin');
end $$;

-- ============================================================ service_role (Edge Functions)
create function public.svc_register_member(p_user_id uuid, p_role public.app_role, p_display_name text,
                                           p_email text, p_invited_by uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_code text;
begin
  insert into public.profiles (id, role, display_name) values (p_user_id, p_role, btrim(p_display_name))
  on conflict (id) do update set role = excluded.role, display_name = excluded.display_name, active = true;
  if p_role = 'operator' then
    insert into public.operators (id, notification_email) values (p_user_id, lower(btrim(p_email)))
    on conflict (id) do update set notification_email = excluded.notification_email
    returning operator_code into v_code;
  end if;
  insert into public.audit_logs (actor_id, actor_role, action, details)
  values (p_invited_by, 'admin', 'member.invited', jsonb_build_object('profile_id', p_user_id, 'role', p_role));
  return jsonb_build_object('profile_id', p_user_id, 'operator_code', v_code);
end $$;

-- Reserva notificações vencidas. Destinatário resolvido aqui: o e-mail não é copiado para a fila.
create function public.svc_claim_notifications(p_limit integer default 10) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  with due as (
    select n.id from public.notification_queue n
     where n.status = 'pending' and n.next_attempt_at <= now()
     order by n.next_attempt_at
     limit least(greatest(p_limit, 1), 50)
     for update skip locked
  ), locked as (
    update public.notification_queue n
       set status = 'sending', attempts = n.attempts + 1, locked_until = now() + interval '5 minutes'
      from due where n.id = due.id
    returning n.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'notification_id', l.id, 'attempt', l.attempts, 'recipient_email', o.notification_email,
           'operation_ref', r.public_ref, 'adhesion_number', pr.adhesion_number,
           'result_status', pr.result_status, 'completed_at', pr.completed_at)), '[]'::jsonb)
    into v_rows
    from locked l
    join public.proposal_requests r on r.id = l.request_id
    join public.proposal_results pr on pr.request_id = l.request_id
    join public.operators o on o.id = l.recipient_operator_id;
  return v_rows;
end $$;

create function public.svc_finish_notification(p_notification_id uuid, p_ok boolean,
                                               p_provider_message_id text default null,
                                               p_error text default null, p_retryable boolean default true)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_n public.notification_queue;
begin
  select * into v_n from public.notification_queue where id = p_notification_id for update;
  if not found or v_n.status <> 'sending' then return; end if;
  if p_ok then
    update public.notification_queue
       set status = 'sent', sent_at = now(), locked_until = null, last_error = null,
           provider_message_id = left(p_provider_message_id, 128)
     where id = p_notification_id;
  elsif p_retryable and v_n.attempts < private.setting_int('notification_max_attempts') then
    update public.notification_queue
       set status = 'pending', locked_until = null, last_error = left(p_error, 500),
           next_attempt_at = now() + make_interval(mins => least(power(2, v_n.attempts)::integer, 240))
     where id = p_notification_id;
  else
    update public.notification_queue
       set status = 'failed', locked_until = null, last_error = left(p_error, 500)
     where id = p_notification_id;
    insert into public.audit_logs (actor_role, action, request_id, details)
    values ('service', 'notification.failed', v_n.request_id, jsonb_build_object('attempts', v_n.attempts));
  end if;
end $$;

-- ============================================================ permissões de execução
-- Revoga tudo (inclusive o EXECUTE implícito para PUBLIC) e concede apenas o necessário.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.submit_proposal_request(uuid, integer, jsonb, uuid),
  public.cancel_proposal_request(uuid, text),
  public.backoffice_presence(),
  public.acknowledge_received_requests(),
  public.claim_next_job(text, text),
  public.heartbeat_job(uuid, text),
  public.mark_job_running(uuid),
  public.mark_side_effect_started(uuid, text),
  public.complete_job(uuid, text, text, text),
  public.fail_job(uuid, text, text, boolean),
  public.escalate_job(uuid, text, text),
  public.release_job(uuid, text),
  public.resolve_awaiting_request(uuid, text, text, text, text),
  public.requeue_failed_request(uuid),
  public.cancel_request_backoffice(uuid, text),
  public.report_backoffice_heartbeat(text, text),
  public.storage_usage(),
  public.admin_set_member_active(uuid, boolean),
  public.assert_admin()
to authenticated;

revoke execute on function
  public.svc_register_member(uuid, public.app_role, text, text, uuid),
  public.svc_claim_notifications(integer),
  public.svc_finish_notification(uuid, boolean, text, text, boolean)
from public, anon, authenticated;
grant execute on function
  public.svc_register_member(uuid, public.app_role, text, text, uuid),
  public.svc_claim_notifications(integer),
  public.svc_finish_notification(uuid, boolean, text, text, boolean)
to service_role;
