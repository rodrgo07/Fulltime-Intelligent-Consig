# Fulltime Intelligent Consig

Automação da geração de propostas no Consig (Banco BMG). Operadores pedem pelo **site**; um **robô** no PC do
backoffice gera a proposta no Chrome e devolve o número de adesão. O backoffice acompanha, pausa e resolve exceções
pelo **mesmo site**. Nada é instalado no PC do backoffice e nada exige administrador.

> **Estado (v2):** backend, site e robô prontos e testados. O fluxo do Consig (`services/robot/src/fic_robot/consig.py`)
> está **mapeado até a tela de valores** (abrir digitação no ConsigMais, CPF, entidade, produto). Faltam a escolha de
> valor/tabela, o envio e a captura do número de adesão; até lá o fluxo não tem etapa de envio, o robô não reserva
> solicitações e o painel mostra "Fluxo do Consig: não configurado". O `ensaio.bat` roda as etapas mapeadas.

## Componentes

| | Pasta | Tecnologia |
|---|---|---|
| Site único (Operador, Backoffice, Admin) | `apps/web` | React 19, TypeScript, Vite |
| Backend | `supabase/` | Postgres, RLS, funções SQL, pg_cron, Realtime, Edge Function `admin-invite` |
| Robô | `services/robot` | Python ≥ 3.12, Selenium (Chrome instalado), httpx, keyring |
| Contratos e marca | `packages/` | tipos, códigos de erro e rótulos; tokens visuais |

```
Navegador (operador/backoffice) ──HTTPS──▶ Supabase (sa-east-1) ◀──HTTPS (só saída)── Robô no PC do backoffice
                                 ◀Realtime                                              └─ Selenium → Chrome (perfil dedicado)
```

## Regras que não podem quebrar

- **Sem proposta duplicada.** O ponto sem retorno é gravado no banco *antes* da etapa que submete. Depois dele, erro
  vai para "aguardando confirmação", nunca para nova tentativa. Se o robô já capturou o número, o banco recusa
  "reprocessar" e "falhar" (`ROBOT_RESULT_EXISTS`), e o `complete_job` do robô é aceito mesmo depois do escalonamento.
- **Resultado não se perde.** O número vai para `pending-results.json` antes de qualquer chamada; o robô não reserva
  nada novo enquanto houver pendente.
- **Dados pessoais.** O payload só existe em memória durante o job e é apagado no banco ao concluir/cancelar
  (no máximo 72 h). Logs e mensagens de erro passam por redação (CPF, e-mail, números longos). A senha do Consig
  nunca passa pelo robô: a pessoa faz o login na janela do Chrome.
- **Repositório público.** Nenhum segredo, URL de projeto Supabase, credencial ou dado de cliente no código. O mapeamento
  de telas do Consig (`consig.py`) fica no repositório por decisão do responsável (17/11/2026).

## Desenvolvimento

Requisitos: Node 24+, pnpm, Python ≥ 3.12.

```bash
pnpm install
pnpm --filter @fic/supabase test     # banco em PGlite: RLS, fila, retenção, v2 (tests/v2.test.ts)
pnpm --filter @fic/contracts test
pnpm --filter @fic/web test
cd services/robot && python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]" && .venv/Scripts/python -m pytest -q
```

Site local: `pnpm --filter @fic/web dev` (usa `apps/web/.env.local`, ver `.env.example`).

## Robô no PC do backoffice

1. Copiar a pasta `services/robot` para o PC (por exemplo `Documentos\fic-robot`).
2. Copiar `robo.env.example` para `robo.env` e preencher a URL do projeto e a chave **publicável**.
3. Dar dois cliques em `iniciar.bat`. Na primeira vez ele cria o `.venv` na própria pasta e instala as dependências
   (precisa de acesso ao PyPI). Depois pede e-mail, senha e código MFA do usuário backoffice; a senha não é guardada,
   o refresh token fica no Gerenciador de Credenciais do Windows por no máximo 24 h.
4. Para abrir junto com o Windows: atalho do `iniciar.bat` em `shell:startup` (pasta Inicializar do usuário).
5. Atualizar: baixar o zip novo e substituir a pasta (mantendo `robo.env`, `chrome-profile` e `pending-results.json`).

Teste ponta a ponta sem o Consig: `FIC_FAKE_FLOW=1` em `robo.env`. O fluxo falso nunca abre o navegador.

**Ensaio do fluxo do Consig** (`ensaio.bat`, com o robô fechado: os dois usam o mesmo perfil do Chrome): abre o
BMG Consig, espera o login humano (CAPTCHA; o perfil biométrico precisa estar ativo), pede o CPF sem mostrá-lo na
tela e roda as etapas mapeadas, parando antes de qualquer envio. Não fala com o Supabase nem reserva solicitação.
Para continuar o mapeamento, crie as próximas etapas em `consig.py`; a etapa que envia a proposta leva
`side_effect = True` e devolve `ProposalResult(adhesion_number=...)`. Só então o robô passa a reservar jobs.

**Formulário dos operadores:** rodar `supabase/forms/consig-inss-v1.sql` uma vez no SQL Editor (campos `cpf` e
`entidade`, que são os que o `consig.py` lê).

Comandos do painel (Pausar, Retomar, Abrir Consig, Reiniciar) chegam ao robô pela tabela `robot_commands`; o robô
manda sinal de vida para `robot_state` a cada volta (3 s). Sem sinal por mais de 2 min, o painel acende o alerta.

## Primeiros passos em um ambiente novo

1. Criar o projeto Supabase em **sa-east-1** (São Paulo); `supabase link --project-ref <ref>`; `supabase db push`;
   `supabase config push`.
2. Deploy da Edge Function `admin-invite` e `supabase secrets set PORTAL_URL=<endereço do site>`.
3. Bootstrap do primeiro admin/backoffice — `docs/DATABASE_SCHEMA.md`.
4. Publicar o site (Cloudflare Pages) com `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — automático a cada tag
   `vX.Y.Z` (`.github/workflows/deploy.yml`, com aprovação no Environment `production`).
5. Configurar o robô (seção acima).

Nunca use a chave `sb_secret_`/`service_role` no site ou no robô.

## Pendências

- Fluxo do Consig: mapear valor/tabela, envio da proposta e captura do número de adesão (`consig.py`); cadastro
  incompleto (extrato de margem, UF pelo DDD) hoje falha antes do envio e vai para a pessoa resolver.
- IA local (Ollama portátil): o painel já liga/desliga e escolhe o modelo (`robot_state.ai_*`); falta o runtime no robô.
- Consolidar as migrations 0001–0007 num arquivo único antes do primeiro `db push` no projeto novo (opcional).
- Aceites do T.I.: dado do cliente no Supabase (São Paulo), endereço do site, saída para `*.supabase.co` e PyPI.
- Identidade visual vinda do repositório privado (`packages/brand`).

Documentação detalhada da v1 (ainda válida para banco, segurança e LGPD): [docs/](docs/). Plano da v2:
[docs/superpowers/plans/2026-11-17-fic-v2.md](docs/superpowers/plans/2026-11-17-fic-v2.md).
