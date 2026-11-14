# API_CONTRACT — contrato oficial v1

Referência única da comunicação entre **portal web**, **backend (Supabase)**, **app desktop**, **motor RPA** e
**IA local**. Mudanças incompatíveis exigem nova versão (`CONTRACT_VERSION`) e atualização simultânea de:
`supabase/migrations`, `packages/contracts/src/index.ts`, `services/engine/src/fic_rpa/protocol.py`,
`apps/desktop/src-tauri/src/engine.rs` e das fixtures em `packages/contracts/fixtures/`.

## 1. Convenções

- Transporte externo: HTTPS (PostgREST/Auth/Edge Functions do Supabase). Interno: JSON-RPC 2.0 por stdio.
- Autenticação: JWT do Supabase Auth no header `Authorization: Bearer`, mais `apikey` (chave pública:
  `sb_publishable_…` ou a `anon` legada). Chaves de API (`sb_…`) nunca vão no `Authorization`; o supabase-js ≥ 2.119
  já faz isso sozinho. Realtime: chave pública no parâmetro `apikey` da URL e JWT do usuário no `access_token` do
  `phx_join` (é ele que aplica o RLS); a inscrição só vale após o evento `system` "Subscribed to PostgreSQL".
- Erros de negócio: `SQLSTATE P0001` com `message` = **código estável** (`RATE_LIMITED`, `PAYLOAD_INVALID`…) e
  `details` opcional. Interfaces mapeiam o código para mensagens (`ERROR_MESSAGE` em `@fic/contracts`).
  **Todo código novo precisa de mensagem:** `packages/contracts/src/index.test.ts` varre `supabase/migrations` e
  `supabase/functions` e falha se algum código não estiver em `ERROR_MESSAGE`. Erros de transporte do PostgREST
  (`PGRST301/302/303` → `UNAUTHENTICATED`, `42501` → `FORBIDDEN`) e de rede (`NETWORK`) também são mapeados.
- Motivos gravados em `status_reason`/`error_code` (banco, motor e desktop) têm rótulo em `STATUS_REASON_LABEL`
  (mesmo teste); texto livre de observação não é exibido ao operador.
- Nenhum dado pessoal em URL, query string, log ou e-mail. IDs técnicos são UUID; a referência exibida
  (`public_ref`, ex. `FIC-261112-9F3A1C2B`) é aleatória e **não** dá acesso a nada.

## 2. Portal → Backend (papel `operator`, aal1)

| Chamada | Tipo | Entrada | Saída |
|---|---|---|---|
| `form_definitions?active=eq.true` | SELECT | — | `{version, title, fields[]}` ou vazio |
| `rpc/submit_proposal_request` | RPC | `p_idempotency_key uuid`, `p_form_version int`, `p_payload jsonb`, `p_owner_operator_id uuid?` | `{request_id, public_ref, status, duplicate}` |
| `rpc/cancel_proposal_request` | RPC | `p_request_id`, `p_reason?` | `{request_id, status}` |
| `proposal_requests?select=…,proposal_results(…)` | SELECT (RLS) | — | solicitações em que é remetente ou proprietário |
| `rpc/backoffice_presence` | RPC | — | `timestamptz` do último heartbeat do backoffice |
| Realtime `postgres_changes` em `proposal_requests` | WS | — | eventos filtrados por RLS |

**Envio** — regras aplicadas no banco (fonte única):
1. papel `operator` ativo; 2. chave de idempotência repetida → devolve o registro existente (`duplicate: true`);
3. proprietário = remetente (regra atual, ver Roadmap); 4. `payload` ≤ `payload_max_bytes`;
5. formulário ativo e versão igual (`FORM_NOT_CONFIGURED`, `FORM_VERSION_OUTDATED`);
6. validação campo a campo (`PAYLOAD_INVALID`, `details` = `[{field, code}]`);
7. rate limit por minuto/dia (`RATE_LIMITED`); 8. mesmo payload em andamento (`DUPLICATE_REQUEST`, `details` = ref).

**Definição de campo** (`form_definitions.fields[]`): `key` (`^[a-z][a-z0-9_]*$`), `label`, `type`
(`text|integer|decimal|date|select|cpf|email|phone`), `required`, `min_length`, `max_length`, `pattern`, `min`,
`max`, `options[{value,label}]`, `help`. Os campos reais **ainda não existem** (dependem do mapeamento do Consig).

## 3. Admin (papel `admin`, **aal2**)

| Chamada | Entrada | Observação |
|---|---|---|
| `POST functions/v1/admin-invite` | `{email, display_name, role}` | 201 `{profile_id, operator_code}`; 401 `UNAUTHENTICATED` (sem JWT de usuário, JWT inválido/expirado ou chave de API no `Authorization`); 403 `FORBIDDEN/MFA_REQUIRED`; 409 `ALREADY_REGISTERED`; 422 `INVALID_INPUT`. `verify_jwt = false`: a função valida o JWT (PostgREST + Auth) |
| `rpc/admin_set_member_active` | `p_profile_id`, `p_active` | desativar revoga refresh tokens; acesso barrado imediatamente nas RPCs |
| `profiles?select=…,operators(…)` | — | listagem de membros |

## 4. Desktop → Backend (papel `backoffice`, **aal2**)

| RPC | Efeito |
|---|---|
| `report_backoffice_heartbeat(p_app_version, p_channel)` | registra versão/presença (`app_versions`) |
| `acknowledge_received_requests()` | `received → queued` (confirma recebimento) |
| `claim_next_job(p_worker_id, p_app_version)` | FIFO; `null` se fila vazia **ou** sessão do Consig ocupada. Retorna `{job_id, request_id, public_ref, attempt, form_version, fields, payload, lease_expires_at}` |
| `mark_job_running(p_job_id)` | `preparing → running` |
| `heartbeat_job(p_job_id, p_step?)` | renova a reserva (padrão 300 s) |
| `mark_side_effect_started(p_job_id, p_step)` | **ponto sem retorno**: depois dele não há retry automático |
| `complete_job(p_job_id, p_adhesion_number, p_external_operation_id?, p_result_status?)` | grava resultado + notificação e **apaga os dados pessoais na mesma transação**; idempotente |
| `fail_job(p_job_id, p_error_code, p_error_message?, p_retryable)` | antes do ponto sem retorno: re-enfileira até `job_max_attempts`; depois: `awaiting_confirmation` |
| `escalate_job(p_job_id, p_reason_code, p_message?)` | `awaiting_confirmation` |
| `release_job(p_job_id, p_reason_code)` | devolve à fila (recusado após efeito) |
| `resolve_awaiting_request(p_request_id, p_resolution, p_adhesion_number?, p_result_status?, p_note?)` | decisão humana: `completed` (manual) / `requeue` / `failed` |
| `requeue_failed_request(p_request_id)` | só se os dados pessoais ainda existem |
| `cancel_request_backoffice(p_request_id, p_reason)` | cancela e apaga dados pessoais |
| `storage_usage()` | `{database_bytes, limit_bytes, tables, pii_rows}` |

Leitura (RLS staff): `proposal_requests`, `automation_jobs`, `proposal_results`, `audit_logs`, `notification_queue`.

**Recepção confiável**: Realtime acorda o worker; independentemente dele, o worker consulta a cada
`poll_interval_s` (padrão 30 s) e logo após cada reconexão. Reservas expiradas são recuperadas pelo
`pg_cron` (`recover_stale_jobs`, a cada minuto).

## 5. Máquina de estados da solicitação

```
received → queued → preparing → running → completed
    │         │         │   │       │  └→ queued (retry, sem efeito)    awaiting_confirmation → completed | queued | failed | cancelled
    └→ cancelled/failed └→ queued/failed/awaiting_confirmation/cancelled └→ failed | awaiting_confirmation
failed → queued (requeue manual)
```
Transições fora desta tabela são recusadas por trigger (`INVALID_TRANSITION`).

## 6. Desktop ↔ Motor RPA (JSON-RPC 2.0, uma linha por mensagem, stdio)

Desktop → motor:

| Método | Parâmetros | Resultado |
|---|---|---|
| `engine.hello` | `{contract_version: 1}` | `{engine_version, contract_version, capabilities:{workflow_ready, workflow_id}}` |
| `engine.health` | — | `{status, workflow_ready, session, current_job, ai}` |
| `engine.shutdown` | — | `{ok}` |
| `session.open` | `{start_url?: "https://…"}` | `{state}` |
| `session.status` / `session.close` | — | `{state}` (`closed|open_unverified|authenticated|expired|browser_missing`) |
| `job.execute` | `{job_id, request_id, public_ref, attempt, form_version, fields, payload, deadline_s}` | `{accepted, job_id}` — ou erro `WORKFLOW_NOT_READY`, `SESSION_UNAVAILABLE`, `ENGINE_BUSY` |
| `job.cancel` | `{job_id}` | `{cancelled}` |
| `ai.status` / `ai.configure` / `ai.install_runtime` / `ai.pull_model` | ver `protocol.py` | estado da IA |

Motor → desktop:

| Mensagem | Conteúdo |
|---|---|
| notificação `job.event` | `{job_id, type: step_started|heartbeat|completed|failed|escalated, step, data}` |
| chamada `host.confirm_side_effect` | `{job_id, step}` → resposta `{confirmed: bool}`. Sem `true`, a etapa com efeito **não roda** |

`data` de `completed`: `{adhesion_number, result_status, external_operation_id}`; de `failed`:
`{error_code, message, retryable}`; de `escalated`: `{reason_code, message}`. O payload nunca volta pelo canal.
Erros: `-32700` JSON inválido, `-32601` método inexistente, `-32602` parâmetros inválidos (`data.fields`),
`-32000` erro do motor (`data.code`). Métodos `host.*` diferentes de `confirm_side_effect` são rejeitados pelo desktop.

## 7. Motor RPA ↔ IA local

Interface `Advisor.advise(step, allowed[], observation) → Advice | None`. A IA recebe texto visível/captura de
tela **localmente** e devolve JSON `{situation, action ∈ allowed, confidence}`. Ações possíveis:
`retry_step`, `wait_and_retry`, `escalate`. O executor valida (lista da etapa, confiança mínima, nunca em etapa
com efeito, no máximo 2 recuperações) e executa com código determinístico.

## 8. Backend → E-mail

`pg_cron` → `pg_net` → `functions/v1/dispatch-notifications` (header `x-cron-secret`) → `svc_claim_notifications`
→ Resend (`Idempotency-Key` = id da notificação) → `svc_finish_notification`. Conteúdo: referência, número de
adesão, status, data/hora (America/Sao_Paulo). Destinatário: e-mail cadastrado do **proprietário do cliente**.
