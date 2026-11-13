# SECURITY

> Estas medidas reduzem riscos; **não tornam o sistema "totalmente seguro"**. Antes de operar com dados reais,
> o sistema precisa de revisão técnica independente (pentest) e jurídica.

## Modelo de ameaças (resumo)

| Ameaça | Controle |
|---|---|
| Operador lê dados de outro | RLS por `submitted_by`/`owner_operator_id`; `clients_temp` sem política (inacessível pela API) |
| Escrita direta/forjada via API | `revoke` de INSERT/UPDATE/DELETE; só funções `security definer` com checagem de papel |
| Chamada anônima a RPC | EXECUTE revogado de `PUBLIC`/`anon` (teste automatizado garante) |
| Search-path hijacking | todas as funções com `set search_path = ''` (teste automatizado) |
| SQL injection | nenhum SQL dinâmico; PostgREST parametriza; IDs validados como UUID no desktop |
| Replay/duplicidade | chave de idempotência por envio, fingerprint do payload, JWT de 1 h, rotação de refresh token |
| Abuso/automação no portal | rate limit no banco (10/min, 300/dia por operador), cadastro aberto desligado |
| Roubo de sessão do backoffice | MFA TOTP obrigatório (aal2), refresh token no Credential Manager (DPAPI), validade máxima configurável (24 h) |
| Vazamento da service_role | só existe nas Edge Functions (secret do Supabase). Desktop **recusa** chave `service_role`/`sb_secret_` |
| XSS no portal | React (escape), CSP `script-src 'self'`, sem `dangerouslySetInnerHTML`, `object-src 'none'` |
| CSRF | não aplicável: autenticação por header Bearer, sem cookies de sessão |
| Clickjacking | `frame-ancestors 'none'` |
| Comandos internos expostos (Tauri) | capability mínima (`core:default`), comandos próprios validam entrada, CSP no WebView, `freezePrototype` |
| Motor chama o host indevidamente | desktop só aceita `host.confirm_side_effect`; demais `host.*` são descartados |
| IA executa comandos | IA não tem ferramentas; responde JSON de lista fechada; executor valida; sem acesso a arquivos/sistema |
| Binário de IA adulterado | download do Ollama oficial com SHA-256 fixado; zip validado contra path traversal |
| Atualização maliciosa | updater do Tauri com assinatura minisign; chave pública embutida; build só por CI com tag aprovada |
| Logs com dados pessoais | logs só com IDs técnicos; redação automática de CPF/e-mail/números longos; payload nunca é logado |
| Perda de resultado | arquivo local de resultados pendentes + `complete_job` idempotente |

## Segredos

| Segredo | Onde fica | Nunca |
|---|---|---|
| service_role | injetado pelo Supabase nas Edge Functions | portal, desktop, repositório |
| `RESEND_API_KEY`, `MAIL_FROM`, `CRON_SECRET`, `PORTAL_URL` | `supabase secrets set` | repositório |
| `fic_functions_url`, `fic_cron_secret` | Supabase Vault | migrations |
| Chave privada de assinatura (`TAURI_SIGNING_PRIVATE_KEY` + senha) | GitHub Actions secrets | máquinas de operadores, repositório |
| `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | GitHub Environment `production` | repositório |
| Refresh token do backoffice | Windows Credential Manager | arquivos de configuração |
| Senha do Consig | **não armazenada** (login humano) | — |

`.gitignore` bloqueia `.env*`, `*.key`, `*.pem`. A chave **anon** e a chave **pública** do updater não são segredos.

## Windows

- App instalado por usuário (NSIS `currentUser`), sem privilégios de administrador.
- Dados do app em `%LOCALAPPDATA%\br.com.fulltime.intelligentconsig\` (perfil do Chrome, `ialocal`, resultados pendentes).
  Arquivos temporários de download são apagados em qualquer falha.
- Motor e IA rodam como processos filhos sem janela; Ollama escuta só em `127.0.0.1` com prioridade baixa.
- A IA não pode alterar configurações do sistema: não recebe ferramentas e o motor não expõe execução de comandos.

## Repositório público

Migrations, políticas e Edge Functions ficam visíveis. Por isso: nenhum segredo, nenhuma URL interna,
seletor ou detalhe operacional sensível do Consig no código; o endereço do Consig é configuração local.

## Resposta a incidentes (técnico)

1. Desativar acessos afetados (`admin_set_member_active` revoga sessões).
2. Pausar a fila no desktop; se necessário, rotacionar chave anon/JWT secret no Supabase e `CRON_SECRET`.
3. Exportar `audit_logs` e logs do desktop do período.
4. Seguir o procedimento LGPD de incidentes (`LGPD.md`).

## Reportar vulnerabilidade

Não abrir issue pública. Comunicar o responsável técnico da Fulltime diretamente.
