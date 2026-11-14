# ARCHITECTURE

## Visão geral

```
 Operadores (navegador)                     Supabase (único backend)                    PC do backoffice (Windows)
┌──────────────────────┐  HTTPS/JWT   ┌──────────────────────────────────┐  HTTPS/JWT aal2  ┌───────────────────────────────┐
│ Portal (React, CF    │─────────────▶│ Auth (convite, MFA)              │◀────────────────│ App desktop Tauri 2 (Rust)    │
│ Pages, CSP estrita)  │◀── Realtime ─│ Postgres + RLS + funções SQL     │── Realtime ────▶│  • sessão + Credential Manager│
└──────────────────────┘              │   (regras de negócio, fila,      │                  │  • worker da fila (background)│
                                      │    retenção, auditoria)          │                  │  • supervisor do motor        │
                                      │ pg_cron: retenção, recuperação   │                  │  • bandeja, autostart, update │
                                      │ Edge Function: convite           │                  │  UI React 19 (WebView2)       │
                                      │                                  │                  └──────────────┬────────────────┘
                                      └──────────────────────────────────┘                     stdio JSON-RPC│
                                                                                           ┌──────────────▼────────────────┐
                                                                                           │ Motor RPA (Python sidecar)    │
                                                                                           │  executor · sessão · etapas   │
                                                                                           │  Playwright → Google Chrome   │──▶ Consig (BMG)
                                                                                           │  fic_ai → Ollama portátil     │
                                                                                           │  (sob demanda, 127.0.0.1)     │
                                                                                           └───────────────────────────────┘
```

## Componentes e responsabilidades

| Componente | Pasta | Responsabilidade | Não faz |
|---|---|---|---|
| Portal web | `apps/portal` | login, formulário dinâmico, acompanhamento, admin | validar regras (só exibe) |
| Backend | `supabase/migrations` | **todas** as regras: validação, rate limit, idempotência, fila, transições, retenção, auditoria | — |
| Integração Supabase (desktop) | `apps/desktop/src-tauri/src/{supabase,auth,realtime}.rs` | REST/Auth/Realtime com JWT do backoffice | usar service_role |
| Edge Functions | `supabase/functions` | convite de membros | regras de fila |
| App desktop | `apps/desktop` | orquestração em segundo plano, UI operacional, integração com Windows | regras de negócio |
| Motor RPA | `services/engine/src/fic_rpa` | executar fluxos em etapas no Consig com segurança | decidir negócio, guardar dados |
| IA local | `services/engine/src/fic_ai`, `ialocal/` | interpretar telas inesperadas, sugerir ação de lista fechada | executar ações, usar APIs externas |
| Atualização | `.github/workflows/release.yml` + plugin updater | builds assinados, canais, instalação verificada | instalar build não assinado |
| Contratos | `packages/contracts` | tipos, rótulos, códigos, fixtures do JSON-RPC | regras |

## Decisões

1. **Backend só no Supabase** (plano gratuito, sem servidor próprio). Regras em funções SQL `security definer`
   com `search_path` vazio; nada de escrita direta via API.
2. **Fila no banco**: `claim_next_job` com `FOR UPDATE SKIP LOCKED` e índice único parcial que impede duas
   propostas ativas — garantia de sessão única do Consig mesmo com bug no cliente.
3. **Desktop é o único cliente do backoffice**: o motor Python não tem credenciais; recebe o job via stdio.
4. **Ponto sem retorno explícito**: antes de qualquer etapa que crie algo no Consig, o banco registra o marco.
   Falhas depois disso vão para confirmação humana — evita proposta duplicada.
5. **Resultado nunca se perde**: o número de adesão é gravado em `pending-results.json` antes do envio;
   `complete_job` é idempotente e atômico (resultado + notificação + exclusão dos dados pessoais).
6. **Realtime + consulta periódica**: eventos aceleram; a consulta garante.
7. **IA opcional e local**: desligada por padrão, carregada sob demanda, descarregada sempre.
8. **Login humano no Consig**: a senha do banco nunca é armazenada.

## Fluxo de uma solicitação

1. Operador envia → `submit_proposal_request` valida e grava (`received`); dados pessoais só em `clients_temp`.
2. Desktop (Realtime ou consulta) → `acknowledge_received_requests` (`queued`).
3. Se motor tem fluxo implementado e sessão do Consig autenticada → `claim_next_job` (`preparing`) →
   `mark_job_running` (`running`) → `job.execute`.
4. Motor executa etapas; heartbeats renovam a reserva; antes de etapa com efeito → `host.confirm_side_effect`
   → `mark_side_effect_started`.
5. Sucesso → `complete_job`: resultado + exclusão dos dados pessoais (mesma transação).
6. O portal do operador mostra a proposta gerada em tempo real (Realtime + reconsulta). Não há e-mail.
7. Falha → `fail_job`/`escalate_job`; humano decide na Central de Automação.

## Estrutura do repositório

```
apps/portal            portal dos operadores (React 19 + Vite)
apps/desktop           app Tauri 2 (src = UI React, src-tauri = Rust)
packages/contracts     contrato TS + fixtures JSON-RPC
packages/brand         tokens visuais e fontes (IBM Plex)
services/engine        motor RPA (fic_rpa) + IA local (fic_ai), Python 3.12
supabase/migrations    esquema versionado
supabase/functions     Edge Functions (Deno)
supabase/tests         testes de banco (PGlite) e das funções
ialocal/manifest.json  runtime de IA fixado por SHA-256
.github/workflows      CI, release, deploy
docs/                  documentação
SRC/                   logos oficiais (Fulltime, Banco BMG)
```
