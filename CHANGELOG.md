# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versões seguem SemVer.

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
