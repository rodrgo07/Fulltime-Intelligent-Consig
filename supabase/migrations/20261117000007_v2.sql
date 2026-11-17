-- v2: correções da revisão de 17/11 + controle do robô pelo banco.
-- Ver docs/superpowers/plans/2026-11-17-fic-v2.md (problemas P2–P8).
-- Roda no Supabase real e no PGlite dos testes (sem pgcrypto: HMAC feito com sha256 nativo).

-- ============================================================ P4 — fingerprint com HMAC
create table if not exists private.secrets (
  name text primary key,
  value bytea not null
);
revoke all on private.secrets from public, anon, authenticated;

insert into private.secrets (name, value)
values ('payload_fingerprint',
        decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'))
on conflict (name) do nothing;

-- HMAC-SHA256 (RFC 2104) com sha256() do core; chave de 32 bytes, bloco de 64.
create or replace function private.hmac_sha256(p_key bytea, p_msg bytea) returns text
language plpgsql immutable set search_path = '' as $$
declare
  k bytea := p_key;
  ipad bytea;
  opad bytea;
  i integer;
begin
  if octet_length(k) > 64 then k := sha256(k); end if;
  k := k || decode(repeat('00', 64 - octet_length(k)), 'hex');
  ipad := k; opad := k;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);   -- 0x36
    opad := set_byte(opad, i, get_byte(k, i) # 92);   -- 0x5c
  end loop;
  return encode(sha256(opad || sha256(ipad || p_msg)), 'hex');
end $$;

create or replace function private.payload_fingerprint(p_payload jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select private.hmac_sha256(s.value, convert_to(p_payload::text, 'UTF8'))
    from private.secrets s where s.name = 'payload_fingerprint'
$$;

-- O fingerprint sai de proposal_requests (legível pela API) e vai para uma tabela privada.
-- A coluna antiga fica sempre nula até a consolidação das migrations.
create table if not exists private.request_fingerprints (
  request_id uuid primary key references public.proposal_requests (id) on delete cascade,
  submitted_by uuid not null,
  fingerprint text not null
);
create index if not exists request_fingerprints_lookup on private.request_fingerprints (submitted_by, fingerprint);
revoke all on private.request_fingerprints from public, anon, authenticated;
update public.proposal_requests set payload_fingerprint = null where payload_fingerprint is not null;

create or replace function private.purge_request_pii(p_request_id uuid, p_reason text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_deleted integer;
begin
  delete from public.clients_temp where request_id = p_request_id;
  get diagnostics v_deleted = row_count;
  delete from private.request_fingerprints where request_id = p_request_id;
  update public.proposal_requests
     set pii_purged_at = coalesce(pii_purged_at, now()), payload_fingerprint = null
   where id = p_request_id;
  if v_deleted > 0 then
    perform private.audit('pii.purged', p_request_id, jsonb_build_object('reason', p_reason));
  end if;
  return v_deleted > 0;
end $$;

-- ============================================================ P3 — rate limit auditado
-- O raise desfazia a auditoria. Agora devolve {"error":"RATE_LIMITED"} e a auditoria fica gravada.
create or replace function public.submit_proposal_request(
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

  select * into v_existing from public.proposal_requests
   where submitted_by = v_uid and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('request_id', v_existing.id, 'public_ref', v_existing.public_ref,
                              'status', v_existing.status, 'duplicate', true);
  end if;

  if not exists (select 1 from public.operators where id = v_uid) then
    raise exception using errcode = 'P0001', message = 'NOT_AN_OPERATOR';
  end if;
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
    raise exception using errcode = 'P0001', message = 'FORM_VERSION_OUTDATED', detail = v_form.version::text;
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
    return jsonb_build_object('error', 'RATE_LIMITED');
  end if;

  v_fp := private.payload_fingerprint(p_payload);
  select r.* into v_existing from private.request_fingerprints f
    join public.proposal_requests r on r.id = f.request_id
   where f.submitted_by = v_uid and f.fingerprint = v_fp
     and r.status not in ('completed', 'failed', 'cancelled');
  if found then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_REQUEST', detail = v_existing.public_ref;
  end if;

  insert into public.proposal_requests
    (submitted_by, owner_operator_id, idempotency_key, form_version, pii_expires_at)
  values (v_uid, v_owner, p_idempotency_key, v_form.version, now() + v_ttl)
  returning * into v_req;

  insert into private.request_fingerprints (request_id, submitted_by, fingerprint) values (v_req.id, v_uid, v_fp);

  insert into public.clients_temp (request_id, payload, expires_at)
  values (v_req.id, p_payload, v_req.pii_expires_at);

  perform private.audit('request.received', v_req.id,
    jsonb_build_object('form_version', v_form.version, 'owner_is_submitter', v_owner = v_uid));

  return jsonb_build_object('request_id', v_req.id, 'public_ref', v_req.public_ref,
                            'status', v_req.status, 'duplicate', false);
end $$;

-- ============================================================ P2 — resultado do robô vale (BUG-QA-002)
alter table public.automation_jobs
  add column if not exists captured_adhesion_number text
    check (char_length(captured_adhesion_number) between 1 and 64),
  add column if not exists captured_at timestamptz;

-- O robô grava o número assim que o lê na tela, antes de qualquer outra chamada.
-- Aceita job ativo ou já em confirmação (o robô pode ter escalado e depois lido o número).
create or replace function public.report_captured_result(p_job_id uuid, p_adhesion_number text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.automation_jobs;
begin
  perform private.require_role('backoffice');
  if coalesce(btrim(p_adhesion_number), '') = '' then
    raise exception using errcode = 'P0001', message = 'ADHESION_NUMBER_REQUIRED';
  end if;
  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'JOB_NOT_FOUND'; end if;
  if v_job.status not in ('leased', 'running', 'awaiting_confirmation', 'succeeded') then
    raise exception using errcode = 'P0001', message = 'JOB_NOT_ACTIVE', detail = v_job.status::text;
  end if;
  update public.automation_jobs
     set captured_adhesion_number = coalesce(captured_adhesion_number, left(btrim(p_adhesion_number), 64)),
         captured_at = coalesce(captured_at, now())
   where id = p_job_id;
  perform private.audit('job.result_captured', v_job.request_id, jsonb_build_object('job_id', p_job_id));
end $$;

create or replace function public.complete_job(
  p_job_id uuid, p_adhesion_number text, p_external_operation_id text default null,
  p_result_status text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.automation_jobs;
begin
  perform private.require_role('backoffice');
  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'JOB_NOT_FOUND'; end if;
  if v_job.status <> 'succeeded' and coalesce(btrim(p_adhesion_number), '') = '' then
    raise exception using errcode = 'P0001', message = 'ADHESION_NUMBER_REQUIRED';
  end if;
  if v_job.status = 'succeeded' then
    return jsonb_build_object('request_id', v_job.request_id, 'status', 'completed', 'duplicate', true);
  end if;
  -- Job escalado depois do ponto sem retorno: o resultado do robô é a verdade, não reprocessa.
  if not (v_job.status = 'running'
          or (v_job.status = 'awaiting_confirmation' and v_job.side_effect_started_at is not null)) then
    raise exception using errcode = 'P0001', message = 'JOB_NOT_ACTIVE', detail = v_job.status::text;
  end if;
  update public.automation_jobs
     set status = 'succeeded', finished_at = now(),
         captured_adhesion_number = coalesce(captured_adhesion_number, left(btrim(p_adhesion_number), 64)),
         captured_at = coalesce(captured_at, now())
   where id = p_job_id;
  return private.finalize_success(v_job.request_id, p_job_id, p_adhesion_number,
                                  p_external_operation_id, p_result_status, 'rpa');
end $$;

create or replace function public.resolve_awaiting_request(
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
    return private.finalize_success(p_request_id, v_job.id,
      coalesce(nullif(btrim(p_adhesion_number), ''), v_job.captured_adhesion_number),
      null, p_result_status, 'manual');
  elsif p_resolution in ('requeue', 'failed') then
    -- A proposta já existe no Consig: reprocessar geraria duplicata.
    if v_job.captured_adhesion_number is not null then
      raise exception using errcode = 'P0001', message = 'ROBOT_RESULT_EXISTS',
        detail = v_job.captured_adhesion_number;
    end if;
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

-- ============================================================ P6 — release_job conta tentativas
create or replace function public.release_job(p_job_id uuid, p_reason_code text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.automation_jobs;
  v_next public.request_status;
begin
  perform private.require_role('backoffice');
  v_job := private.open_job(p_job_id);
  if v_job.side_effect_started_at is not null then
    raise exception using errcode = 'P0001', message = 'SIDE_EFFECT_STARTED';
  end if;
  v_next := case when v_job.attempt >= private.setting_int('job_max_attempts') then 'failed' else 'queued' end;
  update public.automation_jobs set status = 'released', finished_at = now(), error_code = left(p_reason_code, 64)
   where id = p_job_id;
  update public.proposal_requests
     set status = v_next,
         status_reason = case v_next when 'failed' then 'MAX_ATTEMPTS' else left(p_reason_code, 500) end
   where id = v_job.request_id;
  perform private.audit('job.released', v_job.request_id,
    jsonb_build_object('job_id', p_job_id, 'code', left(p_reason_code, 64), 'next', v_next));
end $$;

-- ============================================================ P5 — contagens do painel
create or replace function public.dashboard_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role('backoffice');
  return coalesce((select jsonb_object_agg(status, n)
                     from (select status::text, count(*)::int n from public.proposal_requests group by status) s),
                  '{}'::jsonb);
end $$;

-- ============================================================ P7/P8 — controle do robô
create table if not exists public.robot_state (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  consig_session text not null default 'unknown'
    check (consig_session in ('unknown', 'authenticated', 'logged_out')),
  current_step text check (char_length(current_step) <= 100),
  current_job_id uuid,
  version text check (char_length(version) <= 40),
  flow_ready boolean not null default false,
  ai_enabled boolean not null default false,
  ai_model text check (char_length(ai_model) <= 80),
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.robot_state (id) values (true) on conflict (id) do nothing;

create table if not exists public.robot_commands (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('pause', 'resume', 'open_consig', 'restart')),
  requested_by uuid not null references public.profiles (id),
  requested_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists robot_commands_pending_idx on public.robot_commands (id) where delivered_at is null;
create index if not exists robot_commands_requested_by_idx on public.robot_commands (requested_by);

alter table public.robot_state enable row level security;
alter table public.robot_commands enable row level security;
revoke all on public.robot_state, public.robot_commands from anon, authenticated;
grant select on public.robot_state, public.robot_commands to authenticated;
drop policy if exists robot_state_staff on public.robot_state;
create policy robot_state_staff on public.robot_state for select to authenticated using ((select private.is_staff()));
drop policy if exists robot_commands_staff on public.robot_commands;
create policy robot_commands_staff on public.robot_commands for select to authenticated using ((select private.is_staff()));

-- Painel → robô.
create or replace function public.robot_command(p_kind text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_role('backoffice');
  v_id bigint;
begin
  if p_kind not in ('pause', 'resume', 'open_consig', 'restart') then
    raise exception using errcode = 'P0001', message = 'INVALID_COMMAND';
  end if;
  insert into public.robot_commands (kind, requested_by) values (p_kind, v_uid) returning id into v_id;
  perform private.audit('robot.command', null, jsonb_build_object('kind', p_kind, 'command_id', v_id));
  return v_id;
end $$;

-- Robô ← painel: entrega cada comando uma única vez, em ordem.
create or replace function public.robot_poll_commands() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_out jsonb;
begin
  perform private.require_role('backoffice');
  with taken as (
    update public.robot_commands set delivered_at = now()
     where id in (select id from public.robot_commands where delivered_at is null order by id
                  for update skip locked)
    returning id, kind
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind) order by id), '[]'::jsonb)
    into v_out from taken;
  return v_out;
end $$;

-- Robô → banco: sinal de vida + estado. Campos nulos mantêm o valor atual.
create or replace function public.robot_report_state(
  p_paused boolean default null, p_consig_session text default null, p_current_step text default null,
  p_current_job_id uuid default null, p_version text default null, p_flow_ready boolean default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_state public.robot_state;
begin
  perform private.require_role('backoffice');
  if p_consig_session is not null and p_consig_session not in ('unknown', 'authenticated', 'logged_out') then
    raise exception using errcode = 'P0001', message = 'INVALID_SESSION_STATE';
  end if;
  update public.robot_state
     set paused = coalesce(p_paused, paused),
         consig_session = coalesce(p_consig_session, consig_session),
         current_step = left(p_current_step, 100),
         current_job_id = p_current_job_id,
         version = coalesce(left(p_version, 40), version),
         flow_ready = coalesce(p_flow_ready, flow_ready),
         last_seen_at = now(), updated_at = now()
   where id
  returning * into v_state;
  return jsonb_build_object('paused', v_state.paused, 'ai_enabled', v_state.ai_enabled, 'ai_model', v_state.ai_model);
end $$;

-- Painel: liga/desliga IA local e escolhe o modelo.
create or replace function public.robot_set_ai(p_enabled boolean, p_model text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_role('backoffice');
  update public.robot_state set ai_enabled = p_enabled, ai_model = coalesce(left(p_model, 80), ai_model),
                                updated_at = now() where id;
  perform private.audit('robot.ai_set', null, jsonb_build_object('enabled', p_enabled, 'model', left(p_model, 80)));
end $$;

-- ============================================================ permissões
revoke execute on function private.hmac_sha256(bytea, bytea), private.payload_fingerprint(jsonb)
  from public, anon, authenticated;
revoke execute on function
  public.report_captured_result(uuid, text), public.dashboard_counts(), public.robot_command(text),
  public.robot_poll_commands(), public.robot_report_state(boolean, text, text, uuid, text, boolean),
  public.robot_set_ai(boolean, text)
from public, anon;
grant execute on function
  public.report_captured_result(uuid, text), public.dashboard_counts(), public.robot_command(text),
  public.robot_poll_commands(), public.robot_report_state(boolean, text, text, uuid, text, boolean),
  public.robot_set_ai(boolean, text)
to authenticated;

-- Realtime: painel e robô ouvem robot_state/robot_commands (só no Supabase real).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'robot_state') then
      alter publication supabase_realtime add table public.robot_state;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'robot_commands') then
      alter publication supabase_realtime add table public.robot_commands;
    end if;
  end if;
end $$;
