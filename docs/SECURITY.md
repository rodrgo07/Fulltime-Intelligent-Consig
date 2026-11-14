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
| Vazamento da service_role | só existe nas Edge Functions (secret do Supabase). Desktop **só aceita** `sb_publishable_…` ou o JWT `anon` legado: `sb_secret_`/`service_role` dão `SERVICE_ROLE_FORBIDDEN` (na configuração e de novo ao montar o cliente HTTP, cobrindo `config.json` editado à mão); outros formatos dão `INVALID_ANON_KEY` |
| Edge Function chamada sem usuário | `admin-invite` com `verify_jwt = false` (o check do gateway não é confiável com as chaves novas) e validação no código: exige `Authorization: Bearer <JWT>`, recusa chaves `sb_` ali, `assert_admin` valida a assinatura no PostgREST e `auth.getUser` confirma o usuário. `dispatch-notifications`: `x-cron-secret` |
| RPC `security definer` executável por `authenticated` (advisor `authenticated_security_definer_function_executable`) | **aceito**: as funções de `public` concedidas a `authenticated` (migration `…0003`) são a superfície da API; cada uma valida o papel e o MFA por dentro (`private.require_role`) e aplica as regras de negócio. `assert_admin()` também é exposta de propósito: o `admin-invite` a chama com o JWT do usuário para que o PostgREST valide a assinatura e o banco confira papel + aal2; ela não lê nem grava nada. Funções `svc_*` só para `service_role`; helpers internos ficam em `private` |
| Tabela sem política (advisor `rls_enabled_no_policy` em `clients_temp`) | **intencional**: RLS ligado e nenhuma política = inacessível pela API; os dados pessoais só passam por funções controladas |
| XSS no portal | React (escape), CSP `script-src 'self'`, sem `dangerouslySetInnerHTML`, `object-src 'none'` |
| CSRF | não aplicável: autenticação por header Bearer, sem cookies de sessão |
| Clickjacking | `frame-ancestors 'none'` |
| Comandos internos expostos (Tauri) | capability mínima (`core:default`), comandos próprios validam entrada, CSP no WebView, `freezePrototype` |
| Motor chama o host indevidamente | desktop só aceita `host.confirm_side_effect`; demais `host.*` são descartados |
| Atualização maliciosa | updater do Tauri com assinatura minisign; chave pública embutida; build só por CI com tag aprovada |
| Logs com dados pessoais | logs só com IDs técnicos; redação automática de CPF/e-mail/números longos; payload nunca é logado |
| Perda de resultado | arquivo local de resultados pendentes + `complete_job` idempotente |

## Segredos

| Segredo | Onde fica | Nunca |
|---|---|---|
| Chave de servidor (`sb_secret_…`; legada `service_role`) | injetada pelo Supabase nas Edge Functions (`SUPABASE_SECRET_KEYS`, JSON por nome, `default`; alternativa `SUPABASE_SERVICE_ROLE_KEY`) — nunca configurar à mão | portal, desktop, repositório |
| `RESEND_API_KEY`, `MAIL_FROM`, `CRON_SECRET`, `PORTAL_URL` | `supabase secrets set` | repositório |
| `fic_functions_url`, `fic_cron_secret` | Supabase Vault (o valor de `fic_cron_secret` é o mesmo do secret `CRON_SECRET`; gerar e gravar os dois no mesmo comando, sem imprimir) | migrations |
| Chave privada de assinatura (`TAURI_SIGNING_PRIVATE_KEY` + senha) | GitHub Actions secrets | máquinas de operadores, repositório |
| `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | GitHub Environment `production` | repositório |
| Refresh token do backoffice | Windows Credential Manager | arquivos de configuração |
| Senha do Consig | **não armazenada** (login humano) | — |

Hospedagem: o projeto Supabase de produção (`qqgzbuaizprpmjeozzis`) está em **us-east-1**: há transferência
internacional de dados (ver `LGPD.md` §1). Auth: cadastro aberto desligado (`auth.enable_signup = false`) e
provedor de e-mail **ligado** (`auth.email.enabled = true`; não usar `auth.email.enable_signup`, que no CLI v3
desliga o login por e-mail). Os templates PT-BR (`supabase/templates/`) só sobem no `config push` depois do SMTP
próprio (Resend) configurado: no plano free o Supabase recusa templates com o SMTP padrão.

`.gitignore` bloqueia `.env*`, `*.key`, `*.pem`. A chave **publishable**/**anon** e a chave **pública** do updater não são segredos.

## Windows

- App instalado por usuário (NSIS `currentUser`), sem privilégios de administrador.
- Dados do app em `%LOCALAPPDATA%\br.com.fulltime.intelligentconsig\` (perfil do Chrome, resultados pendentes).
  Arquivos temporários de download são apagados em qualquer falha.
- O motor roda como processo filho sem janela.

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
