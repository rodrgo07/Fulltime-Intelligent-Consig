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
| Vazamento da service_role | não há Edge Functions: a chave de servidor só é usada por quem administra (SQL Editor/CLI). Desktop **só aceita** `sb_publishable_…` ou o JWT `anon` legado: `sb_secret_`/`service_role` dão `SERVICE_ROLE_FORBIDDEN` (na configuração e de novo ao montar o cliente HTTP, cobrindo `config.json` editado à mão); outros formatos dão `INVALID_ANON_KEY` |
| Cadastro/recuperação sem e-mail | só um admin cria usuários (painel + SQL Editor), com a identidade conferida fora do sistema; senha provisória entregue por canal seguro e **troca obrigatória** no primeiro login (`must_change_password`); MFA perdido só é removido pelo admin |
| RPC `security definer` executável por `authenticated` (advisor `authenticated_security_definer_function_executable`) | **aceito**: as funções de `public` concedidas a `authenticated` (migration `…0003`) são a superfície da API; cada uma valida o papel e o MFA por dentro (`private.require_role`) e aplica as regras de negócio. Funções `svc_*` só para `service_role`; helpers internos ficam em `private` |
| Tabela sem política (advisor `rls_enabled_no_policy` em `clients_temp`) | **intencional**: RLS ligado e nenhuma política = inacessível pela API; os dados pessoais só passam por funções controladas |
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
| Chave de servidor (`sb_secret_…`; legada `service_role`) | só no painel do Supabase/cofre de quem administra; o B8 a lê de um `.env` fora do git | portal, desktop, repositório |
| Chave privada de assinatura (`TAURI_SIGNING_PRIVATE_KEY` + senha) | GitHub Actions secrets | máquinas de operadores, repositório |
| `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | GitHub Environment `production` | repositório |
| Refresh token do backoffice | Windows Credential Manager | arquivos de configuração |
| Senha do Consig | **não armazenada** (login humano) | — |

Hospedagem: o projeto Supabase de produção (`qqgzbuaizprpmjeozzis`) está em **us-east-1**: há transferência
internacional de dados (ver `LGPD.md` §1). Auth: cadastro aberto desligado (`auth.enable_signup = false`) e
provedor de e-mail **ligado** (`auth.email.enabled = true`; não usar `auth.email.enable_signup`, que no CLI v3
desliga o login por e-mail). **O sistema não envia e-mail**: sem templates, sem SMTP próprio, sem confirmação
de cadastro ou de troca de e-mail e `secure_password_change = false` (a troca de senha logada não pede código).

`.gitignore` bloqueia `.env*`, `*.key`, `*.pem`. A chave **publishable**/**anon** e a chave **pública** do updater não são segredos.

## Windows

- App instalado por usuário (NSIS `currentUser`), sem privilégios de administrador.
- Dados do app em `%LOCALAPPDATA%\br.com.fulltime.intelligentconsig\` (perfil do Chrome, `ialocal`, resultados pendentes).
  Arquivos temporários de download são apagados em qualquer falha.
- Motor e IA rodam como processos filhos sem janela; Ollama escuta só em `127.0.0.1` com prioridade baixa.
- A IA não pode alterar configurações do sistema: não recebe ferramentas e o motor não expõe execução de comandos.

## Repositório público

Migrations e políticas ficam visíveis. Por isso: nenhum segredo, nenhuma URL interna,
seletor ou detalhe operacional sensível do Consig no código; o endereço do Consig é configuração local.

## Resposta a incidentes (técnico)

1. Desativar acessos afetados (`admin_set_member_active` revoga sessões).
2. Pausar a fila no desktop; se necessário, rotacionar chave anon/JWT secret no Supabase.
3. Exportar `audit_logs` e logs do desktop do período.
4. Seguir o procedimento LGPD de incidentes (`LGPD.md`).

## Reportar vulnerabilidade

Não abrir issue pública. Comunicar o responsável técnico da Fulltime diretamente.
