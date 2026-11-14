-- Ajustes de compatibilidade com o Supabase em nuvem (Postgres 17), apontados ao aplicar as
-- migrations num Supabase local real (pg_cron, pg_net, vault, Realtime) e pelos advisors.
-- Idempotente: pode rodar com as migrations anteriores já aplicadas ou não.

-- ---------------------------------------------------------------- pg_net fora do schema public
-- A 0004 cria pg_net sem schema e ele cai em public (advisor extension_in_public).
-- pg_net não é relocável: recria em "extensions". As funções continuam em net.* (o agendamento
-- chama net.http_post) e os jobs do pg_cron guardam só o texto do comando, então nada muda para eles.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_net' and extnamespace = 'public'::regnamespace)
     and exists (select 1 from pg_namespace where nspname = 'extensions') then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end $$;

-- ---------------------------------------------------------------- índices de chaves estrangeiras
-- Advisor unindexed_foreign_keys. As demais FKs já têm índice (ou PK/unique) começando pela coluna.
create index if not exists proposal_requests_form_version_idx on public.proposal_requests (form_version);
create index if not exists automation_jobs_leased_by_idx on public.automation_jobs (leased_by);
create index if not exists proposal_results_job_idx on public.proposal_results (job_id);
create index if not exists proposal_results_confirmed_by_idx on public.proposal_results (confirmed_by);
create index if not exists notification_queue_recipient_idx on public.notification_queue (recipient_operator_id);
create index if not exists app_versions_last_reported_by_idx on public.app_versions (last_reported_by);

-- ---------------------------------------------------------------- RLS: auth.uid() avaliado uma vez
-- Advisor auth_rls_initplan: "(select auth.uid())" vira InitPlan em vez de ser chamado por linha.
-- Mesma regra de acesso das políticas da 0002.
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_staff()));

drop policy if exists operators_self on public.operators;
create policy operators_self on public.operators for select to authenticated
  using (id = (select auth.uid()) or (select private.is_staff()));

drop policy if exists form_definitions_active on public.form_definitions;
create policy form_definitions_active on public.form_definitions for select to authenticated
  using (active or (select private.has_role('admin')));

drop policy if exists requests_participants on public.proposal_requests;
create policy requests_participants on public.proposal_requests for select to authenticated
  using (submitted_by = (select auth.uid()) or owner_operator_id = (select auth.uid()) or (select private.is_staff()));

drop policy if exists results_participants on public.proposal_results;
create policy results_participants on public.proposal_results for select to authenticated
  using (
    (select private.is_staff()) or exists (
      select 1 from public.proposal_requests r
      where r.id = request_id and (r.submitted_by = (select auth.uid()) or r.owner_operator_id = (select auth.uid()))
    )
  );

drop policy if exists jobs_staff on public.automation_jobs;
create policy jobs_staff on public.automation_jobs for select to authenticated using ((select private.is_staff()));
drop policy if exists notifications_staff on public.notification_queue;
create policy notifications_staff on public.notification_queue for select to authenticated using ((select private.is_staff()));
drop policy if exists audit_staff on public.audit_logs;
create policy audit_staff on public.audit_logs for select to authenticated using ((select private.is_staff()));
drop policy if exists versions_staff on public.app_versions;
create policy versions_staff on public.app_versions for select to authenticated using ((select private.is_staff()));
drop policy if exists settings_staff on public.app_settings;
create policy settings_staff on public.app_settings for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------- service_role e o schema private
-- Triggers e defaults das tabelas (validação de form_definitions, máquina de estados, public_ref)
-- chamam funções em private com o papel de quem escreve. A chave de servidor (sb_secret_/service_role)
-- já ignora o RLS e tem todos os privilégios em public, mas sem USAGE em private qualquer escrita
-- direta dela falhava com "permission denied for schema private" (ex.: cadastrar um formulário fictício
-- de homologação). anon e authenticated continuam sem nada além do que a 0002/0004 concedem.
grant usage on schema private to service_role;
grant execute on all functions in schema private to service_role;
