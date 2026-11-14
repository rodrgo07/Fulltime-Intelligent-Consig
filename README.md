# Fulltime Intelligent Consig

Plataforma de automação para geração de propostas de crédito consignado no Consig do Banco BMG.
Operadores enviam solicitações por um **portal web**; um único **computador de backoffice** recebe, enfileira e
executa as propostas com um **motor RPA** e, só em situações excepcionais, uma **IA local** sob demanda.

> **Estado atual (Fase 1):** toda a infraestrutura está implementada e testada. A navegação, o preenchimento e a
> submissão no Consig **ainda não existem** — dependem do mapeamento do sistema real. Até lá o backoffice não
> reserva solicitações (elas ficam “Aguardando processamento”) e o painel informa o motivo.

## Componentes

| | Pasta | Tecnologia |
|---|---|---|
| Portal dos operadores | `apps/portal` | React 19, TypeScript, Vite, CSS próprio |
| App desktop (backoffice) | `apps/desktop` | Tauri 2 (Rust) + React 19 |
| Backend | `supabase/` | Postgres, RLS, funções SQL, pg_cron, Realtime |
| Motor RPA + IA local | `services/engine` | Python 3.12, Playwright (Google Chrome), Ollama portátil |
| Contratos e marca | `packages/` | tipos compartilhados, fixtures, tokens visuais |

## Documentação

[Arquitetura](docs/ARCHITECTURE.md) · [Contrato de API](docs/API_CONTRACT.md) · [Banco](docs/DATABASE_SCHEMA.md) ·
[Segurança](docs/SECURITY.md) · [LGPD](docs/LGPD.md) · [Motor RPA](docs/RPA_ENGINE.md) · [IA local](docs/LOCAL_AI.md) ·
[Atualizações](docs/UPDATE_SYSTEM.md) · [Acessibilidade](docs/ACCESSIBILITY.md) ·
[Roadmap e pendências](docs/DEVELOPMENT_ROADMAP.md) · [Changelog](CHANGELOG.md)

## Desenvolvimento

Requisitos: Node 24+, pnpm, Rust (stable-msvc) + Visual Studio Build Tools, uv, Windows 10/11 com WebView2.

```bash
pnpm install
pnpm --filter @fic/supabase test        # banco (PGlite) + config.toml + fila ponta a ponta (sobe o motor; precisa do uv)
pnpm --filter @fic/contracts test
pnpm --filter @fic/portal test
pnpm --filter @fic/desktop test         # interface do desktop (IPC do Tauri simulado)
cd services/engine && uv sync && uv run pytest -q
cd apps/desktop/src-tauri && cargo test # precisa de apps/desktop/dist/index.html e do sidecar placeholder, como no CI
```

Testes de segurança contra a homologação real (só leitura por padrão; variáveis em
`supabase/tests/live/security.live.test.ts`): `pnpm --filter @fic/supabase test:live`.
Testes de bug conhecido usam `it.fails` (vitest) ou `#[ignore = "BUG-QA-…"]` (Rust): quando o bug for corrigido,
eles passam a falhar e devem virar testes normais.

Rodar:

```bash
pnpm --filter @fic/portal dev                                 # portal em http://localhost:5174 (usa apps/portal/.env.local)
cd services/engine && uv run python scripts/build_sidecar.py  # gera o motor para o desktop
pnpm --filter @fic/desktop tauri dev                          # app desktop
```

## Primeiros passos em um ambiente novo

1. Criar o projeto Supabase; `supabase link --project-ref <ref>`; `supabase db push`; `supabase config push`.
2. Cadastro do primeiro admin e dos demais membros, sem e-mail — `docs/DATABASE_SCHEMA.md#cadastro-de-membros-sem-e-mail`.
3. O sistema não envia e-mail e não tem Edge Functions: não há secrets de função a configurar.
4. Publicar o portal (Cloudflare Pages) com `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — automático a cada
   tag `vX.Y.Z` (`.github/workflows/deploy.yml`, com aprovação no Environment `production`).
5. Instalar o app no PC do backoffice, informar URL + chave pública (`sb_publishable_…` ou anon legada), entrar com MFA.

Nunca use a chave `sb_secret_`/`service_role` no portal ou no desktop — o app a recusa.
