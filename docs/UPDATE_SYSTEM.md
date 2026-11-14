# UPDATE_SYSTEM

Atualização automática do app do backoffice com o **plugin oficial de updater do Tauri 2** e GitHub Releases.

## Canais

| Canal | Origem | App instalado | Endpoint do updater |
|---|---|---|---|
| development | `tauri dev` local | — | desativado (sem chave pública) |
| staging | push em `develop` | “Fulltime Intelligent Consig (Homologação)” — identificador `…intelligentconsig.staging`, dados separados | `releases/download/staging/latest.json` (pre-release) |
| production | tag `vX.Y.Z` + **aprovação** no Environment `production` | “Fulltime Intelligent Consig” | `releases/latest/download/latest.json` (ignora pre-releases) |

Commits comuns nunca viram produção. A versão da tag precisa ser igual à de `tauri.conf.json`.

## Pipeline (`.github/workflows/release.yml`)

1. Pré-condições: variável `TAURI_UPDATER_PUBKEY` e secret `TAURI_SIGNING_PRIVATE_KEY` existem.
2. Testes (banco, contratos, portal, motor, Rust).
3. Gera `tauri.channel.conf.json` (versão, identificador, chave pública, endpoint — nada secreto).
4. Empacota o sidecar Python e faz o build NSIS com `createUpdaterArtifacts`.
5. Assina com a chave privada (secret) e publica instalador, `.sig` e `latest.json`.

## No aplicativo

- Verifica ao iniciar e a cada 6 h; mostra versão instalada e disponível (Painel e Configurações → Atualizações).
- Instalação **sempre** iniciada pelo usuário, nunca durante uma proposta em execução; a fila é pausada,
  o pacote é baixado, a **assinatura é verificada com a chave pública embutida** e só então instalado; o app reinicia.
- Assinatura inválida/ausente → instalação recusada (`UPDATE_INSTALL_FAILED`), nada muda.

## Configuração única (responsável técnico)

1. Gerar o par de chaves (fora do repositório):
   ```bash
   pnpm --filter @fic/desktop tauri signer generate -w ~/.tauri/fic-updater.key
   ```
2. GitHub → Settings → Secrets and variables → Actions:
   - secret `TAURI_SIGNING_PRIVATE_KEY` = conteúdo do arquivo `.key`; secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
   - variável `TAURI_UPDATER_PUBKEY` = conteúdo do `.key.pub`.
3. GitHub → Settings → Environments: criar `staging` e `production`; em `production`, **Required reviewers**
   e restrição a tags `v*`.
4. Guardar a chave privada em cofre (perdê-la impede atualizar instalações existentes).

## Lançar uma versão

1. Atualizar `version` em `apps/desktop/src-tauri/tauri.conf.json` (e `Cargo.toml`) e o `CHANGELOG.md`.
2. Merge em `main`; `git tag vX.Y.Z && git push --tags`.
3. Aprovar o deploy no GitHub. O app de produção detecta a nova versão.
   A mesma tag dispara `deploy.yml` (portal no Cloudflare Pages), que também pede aprovação no Environment
   `production`. Migrations/Edge Functions: Actions → Deploy → Run workflow, escolhendo a **tag** em
   "Use workflow from" e `target = supabase` (a partir de uma branch o Environment recusa).

## Limitações conhecidas

- O executável não tem assinatura Authenticode (certificado de code signing pago): o Windows SmartScreen pode
  alertar na primeira instalação. A integridade das **atualizações** é garantida pela assinatura do Tauri.
- A release rolling `staging` acumula arquivos antigos; limpar periodicamente.
