# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versões seguem SemVer.

## [Não lançado]

### Corrigido
- CI: `deno check` das Edge Functions roda dentro de `supabase/functions` (usa o `deno.json` local); na raiz o
  Deno 2.9 exigia os pacotes npm no `node_modules` do pnpm e reescrevia o `package.json`.
- Deploy: wrangler via `pnpm dlx` com versão fixa (o `cloudflare/wrangler-action` falhava com
  `ERR_PNPM_ADDING_TO_ROOT`); pré-condições listam variáveis e secrets ausentes.
- `supabase/config.toml`: removido `auth.email.enable_signup = false`, que no CLI v3 vira `auth.email.enabled = false`
  e desligaria o login por e-mail; cadastro aberto segue bloqueado por `auth.enable_signup = false`.
- Edge Functions compatíveis com as chaves novas: leem `SUPABASE_SECRET_KEYS`/`SUPABASE_PUBLISHABLE_KEYS`
  (fallback para as legadas); `admin-invite` com `verify_jwt = false` e validação do JWT no código (401
  `UNAUTHENTICATED`); CORS libera `x-client-info` e demais cabeçalhos do supabase-js (o preflight do portal falhava).
- Desktop: aceita só chave publishable/anon, recusa `sb_secret_`/`service_role` também ao montar o cliente HTTP;
  `apikey` do Realtime codificado na URL.
- Migration `…0005`: `pg_net` em `extensions` (advisor `extension_in_public`), índices das FKs, RLS com
  `(select auth.uid())`, `service_role` com acesso a `private`.

### Adicionado
- Templates de e-mail do Auth em PT-BR (convite e recuperação) em `supabase/templates/`; aplicados após o SMTP
  próprio (Resend), exigido pelo Supabase no plano free.
- Teste de regressão do `config.toml` (`supabase/tests/config.test.ts`).
- Documentação: projeto Supabase em us-east-1 (transferência internacional, `LGPD.md`/`SECURITY.md`).
- Verificação de compatibilidade (`supabase/tests/compat/verify.sql`) no job `supabase-compat` do CI e smoke test
  local das chaves novas (`supabase/tests/smoke/new-keys.mjs`).
- QA D3 (segurança, PGlite): anônimo recusado em todas as tabelas/RPCs, JWT sem membro, claims forjadas, isolamento
  entre operadores, rate limit (isolamento, janela, diário), replay da chave de idempotência, entrada hostil.
- QA D3 (portal): XSS em formulário, solicitações e acessos; varredura de sinks de HTML; CSP do portal e do desktop.
- QA D3 (desktop): variações de chave `service_role`/`sb_secret_` recusadas.
- QA D3 (projeto real): suíte `test:live`, pulada sem variáveis de ambiente e só leitura por padrão.
- QA D2: fila ponta a ponta com o motor Python real e um fluxo FALSO só de teste (`services/engine/tests/fake_engine.py`):
  sucesso com e-mail e exclusão dos dados, falha antes/depois do ponto sem retorno, queda do app, queda de rede.
- Testes de bugs conhecidos (`it.fails`): BUG-QA-001 (auditoria do rate limit perdida), BUG-QA-002 (resultado
  pendente bloqueia a fila após decisão humana). Regressão do BUG-QA-003 (`config.json` com `service_role` aceito na
  inicialização), corrigido no PR #4.

### Alterado
- Deploy do portal passa a ocorrer em tags `vX.Y.Z` (não mais a cada push em `main`), coerente com o Environment
  `production` restrito a tags `v*` com aprovação. O deploy manual do Supabase deve ser disparado a partir de uma tag.

## [0.1.0] — 2026-11-12 — Fase 1: infraestrutura

### Adicionado
- Banco Supabase versionado: perfis/operadores, formulário versionado, solicitações, dados temporários do cliente,
  jobs, resultados, fila de notificações, auditoria, versões do app e configurações.
- RLS e privilégios mínimos; regras de negócio em funções SQL (validação de payload, rate limit, idempotência,
  duplicidade, máquina de estados, fila FIFO com sessão única, ponto sem retorno, recuperação de reservas).
- Exclusão atômica dos dados pessoais ao concluir; retenção automática (72 h / 90 dias) via `pg_cron`.
- Edge Functions: envio de e-mail via Resend com idempotência e retentativas; convite de membros por admin com MFA.
- Portal dos operadores: login por convite, definição de senha, formulário dinâmico, acompanhamento em tempo
  real com consulta periódica, cancelamento, administração de acessos com MFA, CSP/HSTS.
- Motor RPA (Python): JSON-RPC por stdio, sessão única do Google Chrome com login humano, executor em etapas com
  timeouts, cancelamento, heartbeat, ponto sem retorno e escalonamento humano; logs com redação de dados pessoais.
- IA local opcional: Ollama portátil verificado por SHA-256, carregado sob demanda e descarregado após cada uso,
  limites de RAM/CPU, inferência única, saída restrita a ações de lista fechada.
- App desktop (Tauri 2): introdução com fundo gerado no Higgsfield e logos oficiais, login com MFA, sessão no
  Credential Manager, painel, central de automação, configurações, logs, diagnóstico, bandeja, inicialização
  com o Windows, instância única, supervisão do motor, worker em segundo plano com resultados pendentes persistidos.
- CI (testes por área), releases staging/production assinadas, deploy do portal e do Supabase.
- Documentação: arquitetura, contrato de API, banco, segurança, LGPD, motor, IA, atualizações e roadmap.

### Pendente
- Fluxo real do Consig, formulário definitivo e captura do número de adesão (Fase 2).
