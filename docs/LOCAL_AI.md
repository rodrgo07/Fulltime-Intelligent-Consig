# LOCAL_AI

IA **auxiliar, opcional e 100% local** (`services/engine/src/fic_ai`). Desativada por padrão.

## Runtime: Ollama portátil (escolhido) vs. llama.cpp

| | Ollama portátil | llama.cpp server |
|---|---|---|
| Visão (imagens) | sim, API estável | sim, depende do modelo/projetor |
| Descarregar após uso | `keep_alive: 0` + encerramento do processo | encerrar processo |
| Gestão de modelos | `pull` do registro oficial | arquivos GGUF manuais |
| Esforço de integração | baixo | maior |

O runtime fica atrás da interface `Runtime` (`service.py`): trocar por llama.cpp exige só outra implementação.

## Instalação (pasta `ialocal/`)

- `ialocal/manifest.json` (no git): versão do Ollama, URL oficial do GitHub, **SHA-256** e tamanho; lista de
  modelos candidatos com RAM aproximada.
- Ao clicar em “Instalar runtime” (Configurações → IA local), o motor baixa o zip (~1,6 GB), confere o hash,
  rejeita entradas com path traversal e extrai em `%LOCALAPPDATA%\…\ialocal\bin`. Modelos em `ialocal\models`.
- Atualizar o Ollama = editar o manifesto com os valores do `sha256sum.txt` da release oficial.

## Escolha do modelo

Nenhum modelo é imposto. O app mede RAM/CPU e sugere o maior candidato de visão que cabe em
**metade da RAM que sobra após reservar 4 GB** para Windows + Chrome/Consig. Ex.: 8 GB → nenhum;
16 GB → até 6 GB de modelo. Só modelos do manifesto podem ser selecionados/baixados.

## Ciclo de uma consulta

1. RPA levanta `UnexpectedScreen(observation)` (texto visível + captura PNG, em memória).
2. Se IA habilitada, modelo escolhido, runtime instalado e **nenhuma outra inferência em curso**:
3. checa RAM livre ≥ mínimo e CPU ≤ máximo (configuráveis); senão desiste (`LOW_MEMORY`/`HIGH_CPU`);
4. inicia `ollama serve` em `127.0.0.1:<porta aleatória>`, prioridade baixa, `OLLAMA_KEEP_ALIVE=0`, 1 modelo;
5. pede JSON restrito por schema (`action ∈ {retry_step, wait_and_retry, escalate}`), `temperature 0`, timeout;
6. **sempre** encerra o processo (libera RAM), mesmo em erro/timeout/cancelamento;
7. o executor valida a sugestão e decide; na dúvida → intervenção humana.

## Limites do que a IA pode fazer

- Não tem ferramentas, não executa comandos, não acessa arquivos, não gera seletores/coordenadas.
- Não aprova operações, não preenche/inventa/corrige dados do cliente, não toma decisão sobre o titular.
- Nunca é usada em etapa com efeito no Consig.
- Nenhum dado sai do PC do backoffice. Não há chamada a APIs externas de IA.

## Configuração (desktop)

`enabled`, `model`, `timeout_s` (90), `min_free_ram_mb` (1500), `max_cpu_percent` (85), `min_confidence` (0,8).
Desabilitar encerra imediatamente qualquer processo da IA. Com a IA desabilitada, telas inesperadas vão direto
para confirmação humana.
