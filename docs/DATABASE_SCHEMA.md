# DATABASE_SCHEMA

Migrations em `supabase/migrations` (aplicadas em ordem; nunca editar uma migration já aplicada em produção —
criar outra). Testes: `pnpm --filter @fic/supabase test` (Postgres real em PGlite com stubs do `auth`).

## Tabelas

| Tabela | Conteúdo | Dados pessoais? | Retenção |
|---|---|---|---|
| `profiles` | papel (`operator`/`admin`/`backoffice`), nome, ativo, `must_change_password` | nome do membro | enquanto ativo |
| `operators` | `operator_code` (OP-0001); o e-mail é só o de login (`auth.users`) | não | enquanto ativo |
| `form_definitions` | versões do formulário (campos em JSON) | não | permanente |
| `proposal_requests` | metadados: ref, remetente, proprietário, estado, datas, `payload_fingerprint` | não (fingerprint é apagado com os dados) | 90 dias após finalizar |
| `clients_temp` | **payload do cliente** | **sim** | até concluir, cancelar ou 72 h |
| `automation_jobs` | tentativas, reserva, etapa, erro técnico, ponto sem retorno | não | com a solicitação |
| `proposal_results` | número de adesão, status, data, origem (rpa/manual) | não | com a solicitação |
| `audit_logs` | ações com IDs técnicos | não | 90 dias |
| `app_versions` | versões/canais reportados pelo backoffice | não | permanente (poucas linhas) |
| `app_settings` | limites e prazos configuráveis | não | permanente |

`schema private`: funções internas (auditoria, validação, retenção, transições) — não expostas pela API.

## Garantias no banco

- `proposal_requests_single_active`: no máximo uma solicitação em `preparing|running|awaiting_confirmation`.
- `automation_jobs_one_open`: no máximo um job aberto.
- `unique(submitted_by, idempotency_key)`: idempotência do envio.
- Trigger `proposal_requests_guard`: só transições válidas.
- Trigger `form_definitions_guard`: definição de campos válida.
- Nenhuma função executável por `anon`; toda `security definer` fixa `search_path` (teste automatizado).
- `service_role` (chave `sb_secret_`) tem `USAGE` em `private` e `EXECUTE` nas funções de lá (migration `…0005`),
  para que escritas diretas dela passem pelos triggers/defaults (ex.: formulário fictício de homologação).
  `anon`/`authenticated` não ganham nada novo.
- Políticas RLS usam `(select auth.uid())` e `(select private.is_staff())` (avaliados uma vez por consulta).

### Compatibilidade com o Supabase real

`supabase/tests/compat/verify.sql` roda no job `supabase-compat` do CI depois de `supabase db start` e falha se
faltar algo que o PGlite não reproduz: `pg_cron` com exatamente os 3 jobs `fic-*`, `pg_net` ausente (removido na
`…0006`), `proposal_requests` na publicação `supabase_realtime`, privilégios de `anon`/`authenticated`/`service_role` e RLS em todas as tabelas.
`supabase/tests/smoke/new-keys.mjs` (`pnpm --filter @fic/supabase smoke:local`) testa num Supabase **local**
completo as chaves novas: RPC com publishable + JWT, recusa do anônimo, Realtime como o desktop faz e a troca de senha obrigatória.
`supabase/tests/smoke/b8-remote.mjs` (`smoke:b8-remote`) faz o mesmo contra o projeto **remoto antes do go-live**
(B8). **Cada execução em produção exige aprovação explícita do usuário.**
- Exige `FIC_B8_ALLOW_REMOTE=<ref do projeto>`. As chaves vêm de um `.env` fora do repositório (`node --env-file=…`)
  ou de `read -rs`, nunca inline na linha de comando (ficariam no histórico do shell).
- Cria usuários `@exemplo.test` com uma marca de execução.
- Aborta se houver formulário ativo, solicitação em andamento ou backoffice visto nos últimos 30 min.
- Cancela a solicitação fictícia logo após o teste de Realtime e apaga tudo no fim (`finally` e Ctrl+C).
- A limpeza apaga `audit_logs` dos dados fictícios, o que só vale antes do go-live.

## Configurações (`app_settings`)

`rate_limit_per_minute` 10 · `rate_limit_per_day` 300 · `payload_max_bytes` 16384 · `pii_ttl_hours` 72 ·
`history_retention_days` 90 · `job_lease_seconds` 300 · `job_max_attempts` 3 ·
`storage_limit_bytes` 524288000.

## Agendamentos

Criados pela migration `…0004` quando `pg_cron` existe (o job de e-mail saiu na `…0006`):

| Job | Frequência | Função |
|---|---|---|
| `fic-recover-stale-jobs` | 1 min | reservas expiradas |
| `fic-retention` | 15 min | exclusão de dados pessoais vencidos, histórico e auditoria |
| `fic-cron-history` | diário | limpa `cron.job_run_details` (preserva armazenamento) |


## Cadastro de membros (sem e-mail)

`profiles.must_change_password` (migration `…0007`): perfis que já existiam ficaram com `false`; cadastros
novos nascem `true`. O portal lê a flag do próprio perfil e só libera o resto depois da troca de senha
(`auth.updateUser`, sem código por e-mail) seguida de `rpc/mark_password_changed`.

O sistema não envia e-mail. Não há convite, recuperação de senha nem confirmação por e-mail. Todo cadastro e toda
recuperação são feitos por um **admin**, no painel do Supabase e no SQL Editor, com conferência da identidade da
pessoa fora do sistema (presencialmente ou por um canal já confiável).

### Primeiro admin (bootstrap)

1. O próprio admin entra no painel do Supabase → **Authentication → Users → Add user → Create new user**, informa o
   e-mail, define a **própria senha** (mínimo de 12 caracteres, com minúscula, maiúscula e número) e marca
   **Auto Confirm User**.
2. No SQL Editor (papel `service_role`/postgres):
   ```sql
   select public.svc_register_member((select id from auth.users where email = '<e-mail>'), 'admin', '<Nome>');
   -- a senha foi escolhida pelo próprio admin: não precisa trocá-la no primeiro acesso
   update public.profiles set must_change_password = false
    where id = (select id from auth.users where email = '<e-mail>');
   ```
3. No primeiro login no portal, o admin cadastra o MFA TOTP (QR code no app autenticador), que é obrigatório
   para admin e backoffice.

### Demais membros (operador e backoffice)

1. O admin cria o usuário em **Authentication → Users → Add user**, com o e-mail, uma **senha provisória** e
   **Auto Confirm User**, e entrega a senha à pessoa por um canal seguro (nunca no mesmo canal do e-mail).
2. SQL Editor:
   ```sql
   select public.svc_register_member((select id from auth.users where email = '<e-mail>'), '<operator|backoffice>', '<Nome>');
   ```
   `must_change_password` nasce `true`: no primeiro login, o portal leva a pessoa à **troca de senha obrigatória**
   e não libera nada antes disso.
3. Backoffice: no primeiro login, cadastra o MFA TOTP (obrigatório). Para o operador, o MFA é opcional.

### Senha esquecida

1. Conferir a identidade da pessoa fora do sistema.
2. Painel → **Authentication → Users → <usuário>** → redefinir a senha para uma provisória (sem e-mail).
3. SQL Editor:
   ```sql
   update public.profiles set must_change_password = true
    where id = (select id from auth.users where email = '<e-mail>');
   ```
4. Entregar a senha provisória por um canal seguro. No próximo login, a pessoa é obrigada a trocá-la.

### MFA perdido (celular trocado ou perdido)

1. Conferir a identidade da pessoa fora do sistema.
2. SQL Editor:
   ```sql
   delete from auth.mfa_factors where user_id = (select id from auth.users where email = '<e-mail>');
   ```
3. No próximo login, a pessoa cadastra um novo fator TOTP.

### Desativar um membro

Portal → **Acessos** → desativar (`admin_set_member_active`): as sessões são revogadas e o acesso, barrado.

### Recuperação do próprio admin

O admin recupera o próprio acesso pelo painel do Supabase (redefinição de senha e remoção do fator, como acima). Por
isso, a conta do supabase.com do responsável **precisa ter MFA** ligado: ela é a via de recuperação de último
recurso. Recomendado ter dois admins.

## Publicar um formulário (após o mapeamento do Consig)

Nova migration:
```sql
update public.form_definitions set active = false where active;
insert into public.form_definitions (version, title, fields, active) values (1, 'Proposta', '[ … ]', true);
```
