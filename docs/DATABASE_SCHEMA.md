# DATABASE_SCHEMA

Migrations em `supabase/migrations` (aplicadas em ordem; nunca editar uma migration já aplicada em produção —
criar outra). Testes: `pnpm --filter @fic/supabase test` (Postgres real em PGlite com stubs do `auth`).

## Tabelas

| Tabela | Conteúdo | Dados pessoais? | Retenção |
|---|---|---|---|
| `profiles` | papel (`operator`/`admin`/`backoffice`), nome, ativo | nome do membro | enquanto ativo |
| `operators` | `operator_code` (OP-0001), e-mail de notificação | e-mail do operador | enquanto ativo |
| `form_definitions` | versões do formulário (campos em JSON) | não | permanente |
| `proposal_requests` | metadados: ref, remetente, proprietário, estado, datas, `payload_fingerprint` | não (fingerprint é apagado com os dados) | 90 dias após finalizar |
| `clients_temp` | **payload do cliente** | **sim** | até concluir, cancelar ou 72 h |
| `automation_jobs` | tentativas, reserva, etapa, erro técnico, ponto sem retorno | não | com a solicitação |
| `proposal_results` | número de adesão, status, data, origem (rpa/manual) | não | com a solicitação |
| `notification_queue` | fila de e-mail (destinatário por referência ao operador) | não | com a solicitação |
| `audit_logs` | ações com IDs técnicos | não | 90 dias |
| `app_versions` | versões/canais reportados pelo backoffice | não | permanente (poucas linhas) |
| `app_settings` | limites e prazos configuráveis | não | permanente |

`schema private`: funções internas (auditoria, validação, retenção, transições) — não expostas pela API.

## Garantias no banco

- `proposal_requests_single_active`: no máximo uma solicitação em `preparing|running|awaiting_confirmation`.
- `automation_jobs_one_open`: no máximo um job aberto.
- `unique(submitted_by, idempotency_key)`: idempotência do envio.
- `unique(request_id, kind)` em `notification_queue`: nunca duas notificações da mesma conclusão.
- Trigger `proposal_requests_guard`: só transições válidas.
- Trigger `form_definitions_guard`: definição de campos válida.
- Nenhuma função executável por `anon`; toda `security definer` fixa `search_path` (teste automatizado).
- `service_role` (chave `sb_secret_`) tem `USAGE` em `private` e `EXECUTE` nas funções de lá (migration `…0005`),
  para que escritas diretas dela passem pelos triggers/defaults (ex.: formulário fictício de homologação).
  `anon`/`authenticated` não ganham nada novo.
- Políticas RLS usam `(select auth.uid())` e `(select private.is_staff())` (avaliados uma vez por consulta).

### Compatibilidade com o Supabase real

`supabase/tests/compat/verify.sql` roda no job `supabase-compat` do CI depois de `supabase db start` e falha se
faltar algo que o PGlite não reproduz: `pg_cron` com os 4 jobs, `pg_net` fora de `public` (a `…0005` o move para
`extensions`), `net.http_post` com a assinatura usada, leitura do Vault pelo `postgres`, `proposal_requests` na
publicação `supabase_realtime`, privilégios de `anon`/`authenticated`/`service_role` e RLS em todas as tabelas.
`supabase/tests/smoke/new-keys.mjs` (`pnpm --filter @fic/supabase smoke:local`) testa num Supabase **local**
completo as chaves novas: RPC com publishable + JWT, recusa do anônimo, Realtime como o desktop faz, convite e
dispatch.

## Configurações (`app_settings`)

`rate_limit_per_minute` 10 · `rate_limit_per_day` 300 · `payload_max_bytes` 16384 · `pii_ttl_hours` 72 ·
`history_retention_days` 90 · `job_lease_seconds` 300 · `job_max_attempts` 3 · `notification_max_attempts` 8 ·
`storage_limit_bytes` 524288000.

## Agendamentos

Criados pela migration `…0004` quando `pg_cron` existe:

| Job | Frequência | Função |
|---|---|---|
| `fic-recover-stale-jobs` | 1 min | reservas expiradas + notificações travadas |
| `fic-retention` | 15 min | exclusão de dados pessoais vencidos, histórico e auditoria |
| `fic-dispatch-notifications` | 1 min | chama a Edge Function só se houver e-mail pendente |
| `fic-cron-history` | diário | limpa `cron.job_run_details` (preserva armazenamento) |

O disparo de e-mail lê dois segredos do **Supabase Vault** (configurar uma vez no SQL Editor):

```sql
select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'fic_functions_url');
select vault.create_secret('<valor aleatório longo>', 'fic_cron_secret');
```
O mesmo valor de `fic_cron_secret` vai em `supabase secrets set CRON_SECRET=…`.

## Primeiro acesso (bootstrap)

1. No painel Supabase → Authentication → convide o primeiro administrador (e o usuário do backoffice).
2. No SQL Editor:
```sql
select public.svc_register_member('<uuid do admin>', 'admin', 'Nome', 'admin@fulltime…', null);
select public.svc_register_member('<uuid do backoffice>', 'backoffice', 'Backoffice', 'backoffice@fulltime…', null);
```
3. Demais operadores: pelo portal (Acessos → Convidar), com MFA do admin.

## Publicar um formulário (após o mapeamento do Consig)

Nova migration:
```sql
update public.form_definitions set active = false where active;
insert into public.form_definitions (version, title, fields, active) values (1, 'Proposta', '[ … ]', true);
```
