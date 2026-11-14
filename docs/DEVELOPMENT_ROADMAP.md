# DEVELOPMENT_ROADMAP

## Fase 1 — Infraestrutura (esta entrega)

Concluído e testado: repositório, banco (migrations, RLS, fila, retenção, auditoria, notificações), Edge Functions,
portal, motor RPA (estrutura), IA local sob demanda, app desktop, intro, CI/CD e updater. Ver `CHANGELOG.md`.

## Pendências que dependem do usuário

| Item | Bloqueia | Ação |
|---|---|---|
| Projeto Supabase criado | uso real de tudo | criar projeto (região BR se possível); informar URL e anon key; `supabase link` + `db push` |
| Bootstrap de admin/backoffice | login | ver `DATABASE_SCHEMA.md#primeiro-acesso-bootstrap` |
| Segredo da Edge Function de convite | convite | `PORTAL_URL` |
| Domínio verificado no Resend | SMTP do Auth (convite, recuperação) | DNS (SPF/DKIM/DMARC) |
| Cloudflare Pages | portal publicado | projeto + token + variáveis no GitHub |
| Repositório GitHub + chaves do updater | releases | `UPDATE_SYSTEM.md` |
| Google Chrome no PC do backoffice | RPA | instalar |
| Mapeamento do Consig | **geração de propostas** | sessão de mapeamento guiada |
| Validação jurídica | dados reais | checklist em `LGPD.md` |

## Fase 2 — Mapeamento do Consig

1. Sessão guiada: login, navegação, telas, campos, mensagens de erro, tela de confirmação e número de adesão.
2. `SessionProbe` real; detecção de sessão expirada.
3. Definição do formulário (`form_definitions` v1) com os campos exigidos.
4. Fluxo `consig_proposal` em etapas, com `side_effect` só na submissão.
5. Testes com páginas locais fictícias + homologação assistida no canal staging.

## Fase 3 — Operação assistida

- Execução com acompanhamento humano; ajuste de timeouts; catálogo de telas inesperadas.
- Avaliação da IA local no hardware real (escolha do modelo, métricas de acerto vs. escalonamento).
- Alertas (notificação do Windows ao entrar em “aguardando confirmação”).

## Fase 4 — Evoluções previstas

- Liberar proprietário ≠ remetente: trocar a verificação `OWNER_NOT_ALLOWED` em `submit_proposal_request`
  por “proprietário é operador ativo” + seletor no portal (as colunas já usam o proprietário).
- Tipos gerados (`supabase gen types`) no portal/desktop.
- Painel de uso de armazenamento com histórico; alertas a 80%.
- Assinatura Authenticode do instalador.
- Rotina de limpeza do perfil do Chrome do backoffice.
