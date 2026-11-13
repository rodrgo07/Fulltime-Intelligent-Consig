-- Recuperação de jobs travados, retenção de dados, agendamentos e Realtime.

-- Job cuja reserva expirou (app fechado, PC desligado, motor travado).
-- Sem efeito iniciado: volta para a fila. Com efeito iniciado: humano precisa conferir no Consig.
create function private.recover_stale_jobs() returns integer
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

  -- Notificações presas em "sending" (função caiu no meio). A chave de idempotência
  -- do provedor impede que o reenvio gere e-mail duplicado.
  update public.notification_queue set status = 'pending', locked_until = null
   where status = 'sending' and locked_until < now();

  return v_count;
end $$;

create function private.run_retention() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_req record;
  v_pii integer := 0;
  v_hist integer;
  v_audit integer;
  v_days interval := make_interval(days => private.setting_int('history_retention_days'));
begin
  -- 1) Dados pessoais vencidos (72h) de solicitações que não estão em execução.
  for v_req in
    select id, status from public.proposal_requests
     where pii_purged_at is null and pii_expires_at < now()
       and status not in ('preparing', 'running')
     for update skip locked
  loop
    if v_req.status in ('received', 'queued') then
      update public.proposal_requests set status = 'failed', status_reason = 'PII_EXPIRED' where id = v_req.id;
    end if;
    if private.purge_request_pii(v_req.id, 'expired') then v_pii := v_pii + 1; end if;
  end loop;

  -- 2) Histórico finalizado além do prazo (resultados, jobs e notificações vão em cascata).
  delete from public.proposal_requests
   where status in ('completed', 'failed', 'cancelled') and updated_at < now() - v_days;
  get diagnostics v_hist = row_count;

  -- 3) Auditoria além do prazo.
  delete from public.audit_logs where occurred_at < now() - v_days;
  get diagnostics v_audit = row_count;

  if v_pii + v_hist > 0 then
    perform private.audit('retention.run', null,
      jsonb_build_object('pii_purged', v_pii, 'requests_deleted', v_hist, 'audit_deleted', v_audit));
  end if;
  return jsonb_build_object('pii_purged', v_pii, 'requests_deleted', v_hist, 'audit_deleted', v_audit);
end $$;

-- Dispara a Edge Function de e-mail apenas quando há notificações vencidas.
-- URL e segredo ficam no Supabase Vault (ver docs/DATABASE_SCHEMA.md#agendamentos); sem eles, não faz nada.
create function private.invoke_notification_dispatch() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from public.notification_queue where status = 'pending' and next_attempt_at <= now()) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'fic_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'fic_cron_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url || '/dispatch-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
end $$;

-- Garante que nenhuma função interna ficou executável pela API.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_app_role(), private.is_aal2(),
  private.has_role(public.app_role), private.is_staff() to authenticated;

-- ---------------------------------------------------------------- agendamentos (Supabase)
-- pg_cron/pg_net existem no Supabase; em ambientes de teste sem as extensões, o bloco é ignorado.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('fic-recover-stale-jobs', '* * * * *', 'select private.recover_stale_jobs()');
    perform cron.schedule('fic-retention', '*/15 * * * *', 'select private.run_retention()');
    perform cron.schedule('fic-cron-history', '0 3 * * *',
      $q$delete from cron.job_run_details where end_time < now() - interval '7 days'$q$);
    if exists (select 1 from pg_available_extensions where name = 'pg_net') then
      create extension if not exists pg_net;
      perform cron.schedule('fic-dispatch-notifications', '* * * * *', 'select private.invoke_notification_dispatch()');
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------- Realtime
-- Apenas metadados (sem dados pessoais); o RLS filtra o que cada usuário recebe.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.proposal_requests;
  end if;
end $$;
