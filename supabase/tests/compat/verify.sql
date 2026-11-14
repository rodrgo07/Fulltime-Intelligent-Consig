-- Verificação pós-migrations num Supabase real (CI: job supabase-compat; local: supabase db start).
-- Falha (ON_ERROR_STOP) se algo que o PGlite não reproduz ficou errado: pg_cron, publicação do Realtime
-- e privilégios dos papéis da API. Não grava nada.
do $$
declare
  missing text;
  n integer;
begin
  -- pg_cron com exatamente os 3 jobs do projeto
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'COMPAT: pg_cron não instalado';
  end if;
  select string_agg(j, ', ') into missing
    from unnest(array['fic-recover-stale-jobs', 'fic-retention', 'fic-cron-history']) j
   where not exists (select 1 from cron.job where jobname = j and active);
  if missing is not null then raise exception 'COMPAT: jobs ausentes em cron.job: %', missing; end if;
  select string_agg(jobname, ', ') into missing from cron.job
   where jobname like 'fic-%' and jobname not in ('fic-recover-stale-jobs', 'fic-retention', 'fic-cron-history');
  if missing is not null then raise exception 'COMPAT: jobs inesperados em cron.job: %', missing; end if;

  -- pg_net saiu com o e-mail de resultado (0006): nada do projeto chama HTTP pelo banco
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'COMPAT: pg_net ainda instalado';
  end if;

  -- Realtime (é por ele que o portal mostra a proposta gerada)
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
  if not has_function_privilege('service_role', 'public.svc_register_member(uuid,public.app_role,text)', 'execute') then
    raise exception 'COMPAT: service_role não executa svc_register_member';
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
