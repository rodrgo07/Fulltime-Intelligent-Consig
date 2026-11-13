# RPA_ENGINE

Motor em Python 3.12 (`services/engine/src/fic_rpa`), empacotado como sidecar
`fic-engine-x86_64-pc-windows-msvc.exe` e controlado pelo app desktop via JSON-RPC por stdio.

## Escolha de tecnologia

O Consig é acessado por **navegador** → **Playwright** controlando o **Google Chrome instalado**
(`channel="chrome"`) com perfil dedicado e persistente (`<dados>/chrome-profile`), janela visível.
Seletores de DOM (roles, labels, `data-*`) têm prioridade; coordenadas de tela não são usadas.
Windows UI Automation/PyAutoGUI não são necessários enquanto o Consig for web.

## Peças

| Módulo | Função |
|---|---|
| `rpc.py` | JSON-RPC bidirecional; limites de tamanho; erros padronizados |
| `protocol.py` | modelos pydantic estritos (`extra="forbid"`) do contrato |
| `session.py` | sessão única do Consig; login **humano**; `SessionProbe` decide se está autenticado |
| `workflow.py` | `Step`, `Workflow`, `StepContext`, `Recovery` |
| `workflows/__init__.py` | registro de fluxos de produção — **vazio** até o mapeamento |
| `executor.py` | execução com timeouts por etapa e por job, heartbeat, cancelamento, ponto sem retorno, IA |
| `errors.py` | erros com códigos estáveis |
| `logs.py` | JSON no stderr com redação de dados pessoais |
| `app.py` | liga tudo e expõe os métodos RPC |

## Máquina de estados do job (no motor)

`step_started*` → `completed` | `failed(retryable?)` | `escalated(reason)`.
- Erro **antes** do ponto sem retorno → `failed` (o banco re-enfileira até 3 tentativas se `retryable`).
- Erro **depois** → sempre `escalated` (confirmação humana; nunca repetição automática).
- `UnexpectedScreen` → IA (se habilitada) pode sugerir `retry_step`/`wait_and_retry` em etapa **sem** efeito,
  no máximo 2 vezes; senão `escalated`.
- Fluxo que termina sem `ProposalResult` → `escalated(NO_RESULT)`.

## Como adicionar o fluxo real (próximas etapas)

1. Mapear com o usuário cada tela do Consig: URL, elementos estáveis, mensagens de erro, tempo esperado.
2. Implementar `SessionProbe` real (ex.: elemento que só existe logado) em `session.py` ou módulo próprio.
3. Criar `workflows/consig_proposal.py` com uma `Step` por tela, marcando `side_effect = True` **somente**
   na etapa que submete a proposta, e uma etapa final que captura o número de adesão e retorna `ProposalResult`.
4. Registrar: `PRODUCTION_WORKFLOWS["consig_proposal"] = build_consig_proposal`.
5. Publicar a `form_definitions` com os campos exigidos (ver `DATABASE_SCHEMA.md`).
6. Testes com HTML local fictício que reproduza a estrutura (sem dados reais) + homologação assistida.

Enquanto o passo 4 não existir, o motor responde `workflow_ready=false` e o desktop **não reserva** nada.

## Execução local

```bash
cd services/engine && uv sync && uv run pytest -q
uv run python -m fic_rpa --data-dir ./.data          # fala JSON-RPC no stdin/stdout
uv run python scripts/build_sidecar.py               # gera o sidecar para o Tauri
```
