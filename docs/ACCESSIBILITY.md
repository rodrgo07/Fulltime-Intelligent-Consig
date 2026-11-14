# ACCESSIBILITY — WCAG 2.1 AA no portal e no desktop

Meta: **WCAG 2.1 nível AA** no portal (`apps/portal`) e na interface do desktop (`apps/desktop/src`).
Os tokens visuais são compartilhados (`packages/brand/tokens.css`), então contraste e foco valem para os dois.

## O que está garantido (e onde é testado)

| Critério | Como | Teste |
|---|---|---|
| 1.4.3 Contraste (texto) | todo token de texto (`--text`, `--text-muted`, `--text-faint`, `--state-*`) ≥ 4,5:1 sobre `--bg`, `--bg-raised`, `--bg-sunken` e `--bg-hover`, nos temas claro e escuro | `apps/portal/src/a11y/contrast.test.ts` (lê o `tokens.css` real) |
| 1.4.11 Contraste não textual | borda de campos/botões (`--line-strong`) e indicador de foco ≥ 3:1 | idem |
| 1.4.1 Uso de cor | estado sempre tem rótulo (`STATUS_LABEL`); cor só reforça | — |
| 1.4.10 Reflow | portal em 320–390 px sem rolagem horizontal: navegação em linha própria, tabelas viram cartões | print `portal-12-celular-solicitacoes` |
| 2.1.1 Teclado | tudo acionável por teclado; na Central de automação a linha tem um botão real (a referência) e `Esc` fecha o painel | `apps/desktop/src/screens/screens.test.tsx` |
| 2.4.1 Pular blocos | link “Pular para o conteúdo” (visível ao receber foco) no portal e no desktop | `App.test.tsx` (portal e desktop) |
| 2.4.2 Título da página | `document.title` muda a cada tela | `App.test.tsx` |
| 2.4.3 Ordem do foco | ao trocar de tela o foco vai para o `<main>`; ao abrir o detalhe, para o título do painel; ao fechar, volta ao botão da linha | `App.test.tsx`, `screens.test.tsx` |
| 2.4.7 Foco visível | `:focus-visible` com contorno de 2 px; campos com contorno de 2 px também no clique | — |
| 2.5.3 Rótulo no nome | botões com `aria-label` contêm o texto visível (ex.: “Cancelar a solicitação FIC-…”) | `pages.test.tsx` |
| 3.3.1 / 3.3.3 Erros | erro do backend vai para o campo (`aria-invalid` + `aria-describedby`) e o foco vai ao primeiro campo inválido; erros gerais em `role="alert"` | `DynamicForm.test.tsx` |
| 3.3.2 Rótulos | todo campo tem `<label>`; aviso “Campos marcados com * são obrigatórios” | `DynamicForm.test.tsx` |
| 4.1.3 Mensagens de status | carregando/sucesso em `role="status"`; erro em `role="alert"`; logs com `aria-live="off"` (atualizam a cada 3 s) | testes de tela |
| 2.3.3 / movimento | `prefers-reduced-motion` reduz animações; a introdução tem modo reduzido | — |

## Estados de tela (C3)

Toda tela que carrega dados tem três estados explícitos, com os componentes `Loading`, `ErrorState` (com
“Tentar novamente”) e `EmptyState` (`components/States.tsx` em cada app; estilos em `tokens.css`):

- **carregando** — nunca fica preso: se a primeira carga falha, aparece o erro com nova tentativa;
- **erro** — mensagem do código estável (`ERROR_MESSAGE`); se já havia dados, eles continuam visíveis com o aviso;
- **vazio** — explica o que aparecerá ali e, quando faz sentido, oferece a próxima ação.

No portal, falha ao carregar o perfil (rede) é diferente de “Acesso não liberado” (perfil inexistente/desativado).

## Aviso de proposta gerada (selo "Nova")

O operador não recebe e-mail de resultado: o aviso é só no portal, em tempo real (Realtime + reconsulta a cada 30 s).

- Proposta que virou `completed` e ainda não foi vista ganha o selo **“Nova”** (texto, não só cor; borda verde na
  linha só reforça). O selo é um botão: clicar ou Enter marca como vista; há também “Marcar todas como vistas”.
- Contador no título da aba e no menu, ex.: “(2) Minhas solicitações”; no menu o leitor de tela ouve
  “Minhas solicitações, 2 propostas novas”.
- Região `role="status"` + `aria-live="polite"` anuncia “Proposta gerada: FIC-…” quando a mudança acontece com o
  portal aberto (em qualquer página). A primeira carga não anuncia o que já estava novo.
- “Vistas” ficam no `localStorage` do navegador, por usuário (`fic:propostas-vistas:<user id>`, só UUIDs). No 1º acesso
  em um navegador, o que já estava concluído conta como visto. Trocar de navegador pode fazer o selo reaparecer.
- Testes: `apps/portal/src/pages/newBadge.test.tsx`.

## Checklist manual (antes de cada release)

- [ ] Navegar só com teclado (Tab, Shift+Tab, Enter, Espaço, Esc) por login, envio, acompanhamento e admin.
- [ ] NVDA + Edge (Windows) no portal e no app instalado (WebView2): títulos, rótulos, alertas e tabelas lidos.
- [ ] Zoom de 200% e largura de 320 px no portal sem perda de conteúdo.
- [ ] Windows em alto contraste: foco e bordas continuam visíveis.

Ainda não verificado em leitor de tela real nem no WebView2 instalado (C2/C6 dependem de dispositivo/instalação).
