-- Remove o e-mail de resultado (decisão do usuário): o operador passa a ver a proposta gerada só no portal,
-- em tempo real (Realtime em proposal_requests, que já existia). Some: fila de notificações, envio por pg_net,
-- Edge Function dispatch-notifications e o job fic-dispatch-notifications.
-- Ordem importa: primeiro nada mais escreve na fila, depois o agendamento sai, depois os objetos.
-- Idempotente (if exists) e roda também sem pg_cron/pg_net (PGlite dos testes).

-- ---------------------------------------------------------------- 1) conclusão sem enfileirar e-mail
-- O insert em notification_queue ficava em private.finalize_success, usada por complete_job e
-- resolve_awaiting_request; essas duas não mudam. Resto idêntico à 0003. create or replace mantém os privilégios.
create or replace function private.finalize_success(
  p_request_id uuid, p_job_id uuid, p_adhesion_number text, p_external_operation_id text,
  p_result_status text, p_source text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if coalesce(btrim(p_adhesion_number), '') = '' then
    raise exception using errcode = 'P0001', message = 'ADHESION_NUMBER_REQUIRED';
  end if;
  perform 1 from public.proposal_requests where id = p_request_id for update;

  insert into public.proposal_results
    (request_id, job_id, adhesion_number, external_operation_id, result_status, completed_at, source, confirmed_by)
  values (p_request_id, p_job_id, btrim(p_adhesion_number), nullif(btrim(p_external_operation_id), ''),
          coalesce(nullif(btrim(p_result_status), ''), 'GERADA'), now(), p_source,
          case when p_source = 'manual' then auth.uid() end);

  update public.proposal_requests set status = 'completed', status_reason = null where id = p_request_id;

  perform private.purge_request_pii(p_request_id, 'completed');
  perform private.audit('request.completed', p_request_id,
    jsonb_build_object('job_id', p_job_id, 'source', p_source));
  return jsonb_build_object('request_id', p_request_id, 'status', 'completed');
end $$;

-- ---------------------------------------------------------------- 2) recuperação sem a fila de e-mail
-- Resto idêntico à 0004.
create or replace function private.recover_stale_jobs() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.automation_jobs;
  v_count integer := 0;
begin
  for v_job in
    select * from public.automation_jobs
     where status in ('leased', 'running') and lease_expires_at < now()
     for update skip locked
  loop
    v_count := v_count + 1;
    if v_job.side_effect_started_at is not null then
      perform private.escalate(v_job, 'LEASE_EXPIRED_AFTER_SIDE_EFFECT', 'Reserva expirou após etapa com efeito no Consig');
    else
      update public.automation_jobs set status = 'released', finished_at = now(), error_code = 'LEASE_EXPIRED'
       where id = v_job.id;
      update public.proposal_requests
         set status = case when v_job.attempt < private.setting_int('job_max_attempts')
                           then 'queued' else 'failed' end::public.request_status,
             status_reason = 'LEASE_EXPIRED'
       where id = v_job.request_id;
      perform private.audit('job.lease_expired', v_job.request_id, jsonb_build_object('job_id', v_job.id));
    end if;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------- 3) agendamento
do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'fic-dispatch-notifications') then
      perform cron.unschedule('fic-dispatch-notifications');
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------- 4) funções do envio
drop function if exists private.invoke_notification_dispatch();
drop function if exists public.svc_claim_notifications(integer);
drop function if exists public.svc_finish_notification(uuid, boolean, text, text, boolean);

-- ---------------------------------------------------------------- 5) fila e tipo
-- Leva junto índices, política RLS e a entrada na lista de tabelas; nenhum dado pessoal ficava aqui.
drop table if exists public.notification_queue;
drop type if exists public.notification_status;

-- ---------------------------------------------------------------- 6) configuração
delete from public.app_settings where key = 'notification_max_attempts';

-- ---------------------------------------------------------------- 7) pg_net
-- Só o dispatch usava. Não remove se ainda houver uso: Database Webhooks (gatilhos com
-- supabase_functions.http_request) ou alguma função do projeto chamando net.http_*.
do $$
declare v_users integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return;
  end if;
  select count(*) into v_users
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosrc ~* 'net\.http_';
  if to_regnamespace('supabase_functions') is not null then
    v_users := v_users + (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                           join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'supabase_functions' and p.proname = 'http_request');
  end if;
  if v_users = 0 then
    drop extension pg_net;
  else
    raise notice 'pg_net mantido: % uso(s) encontrado(s)', v_users;
  end if;
end $$;
