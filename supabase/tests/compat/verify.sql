-- Verificação pós-migrations num Supabase real (CI: job supabase-compat; local: supabase db start).
-- Falha (ON_ERROR_STOP) se algo que o PGlite não reproduz ficou errado: pg_cron, pg_net, vault,
-- publicação do Realtime e privilégios dos papéis da API. Não grava nada.
do $$
declare
  missing text;
  n integer;
begin
  -- pg_cron com os 4 jobs do projeto
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'COMPAT: pg_cron não instalado';
  end if;
  select string_agg(j, ', ') into missing
    from unnest(array['fic-recover-stale-jobs', 'fic-retention', 'fic-cron-history', 'fic-dispatch-notifications']) j
   where not exists (select 1 from cron.job where jobname = j and active);
  if missing is not null then raise exception 'COMPAT: jobs ausentes em cron.job: %', missing; end if;

  -- pg_net instalado e fora de public (advisor extension_in_public)
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'COMPAT: pg_net não instalado';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_net' and extnamespace = 'public'::regnamespace) then
    raise exception 'COMPAT: pg_net no schema public';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'COMPAT: net.http_post com a assinatura usada em invoke_notification_dispatch não existe';
  end if;

  -- Vault legível pelo dono das funções (postgres)
  if not has_table_privilege('postgres', 'vault.decrypted_secrets', 'select') then
    raise exception 'COMPAT: postgres sem acesso a vault.decrypted_secrets';
  end if;

  -- Realtime
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'proposal_requests') then
    raise exception 'COMPAT: proposal_requests fora da publicação supabase_realtime';
  end if;

  -- anon: nada em public/private
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute');
  if n > 0 then raise exception 'COMPAT: anon executa % função(ões) do projeto', n; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert'));
  if n > 0 then raise exception 'COMPAT: anon acessa % tabela(s) de public', n; end if;

  -- authenticated: só leitura direta; nunca clients_temp; nunca svc_*
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
          or has_table_privilege('authenticated', c.oid, 'delete'));
  if n > 0 then raise exception 'COMPAT: authenticated escreve direto em % tabela(s)', n; end if;
  if has_table_privilege('authenticated', 'public.clients_temp', 'select') then
    raise exception 'COMPAT: authenticated lê clients_temp';
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname like 'svc\_%' and has_function_privilege('authenticated', p.oid, 'execute');
  if n > 0 then raise exception 'COMPAT: authenticated executa svc_*'; end if;
  if not has_function_privilege('service_role', 'public.svc_claim_notifications(integer)', 'execute') then
    raise exception 'COMPAT: service_role não executa svc_claim_notifications';
  end if;

  -- RLS ligado em todas as tabelas de public
  select string_agg(c.relname, ', ') into missing from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then raise exception 'COMPAT: RLS desligado em %', missing; end if;

  raise notice 'COMPAT OK';
end $$;

-- As funções agendadas rodam sem erro no ambiente real (sem trabalho pendente, não alteram nada).
select private.recover_stale_jobs();
select private.run_retention();
select private.invoke_notification_dispatch();
