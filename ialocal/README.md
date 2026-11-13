# ialocal/

Pasta da IA local (Ollama portátil). **Somente o manifesto vai para o git.**

- `manifest.json` — versão do runtime, URL oficial e SHA-256 fixado; modelos candidatos (nenhum é escolhido
  antes de medir o PC do backoffice).
- `bin/` e `models/` — criados pelo app no PC do backoffice, dentro da pasta de dados do aplicativo
  (`%LOCALAPPDATA%\FulltimeIntelligentConsig\ialocal\`), quando a IA é ativada nas Configurações.
  Ignorados pelo git.

O download só é aceito se o SHA-256 conferir. Para atualizar o Ollama: troque `version`, `url`, `sha256` e
`size_bytes` com os valores do `sha256sum.txt` da release oficial e rode os testes. Detalhes em `docs/LOCAL_AI.md`.
