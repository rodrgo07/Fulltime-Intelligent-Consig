# LGPD — Lei 13.709/2018

> Documento técnico de apoio. **Não substitui** a análise do encarregado (DPO) e do jurídico. A adequação à LGPD
> depende de processos, contratos e decisões da organização, não apenas do software. Itens marcados
> **[VALIDAR]** precisam de decisão jurídica antes da operação com dados reais.

## 1. Agentes de tratamento [VALIDAR]

- **Controlador**: definir se é a Fulltime (correspondente) e/ou o Banco BMG para cada finalidade. A relação
  com o banco e com os clientes determina papéis e responsabilidades.
- **Operadores (LGPD)**: Supabase (banco/autenticação/hospedagem), Cloudflare (hospedagem do portal),
  Resend (SMTP do Auth: convite e recuperação de senha), GitHub (código e distribuição do app). Exigir contratos/DPAs e verificar
  transferência internacional (art. 33) — os provedores podem armazenar dados fora do Brasil; escolher região
  do projeto Supabase compatível.
- **Região do Supabase (decisão de 2026-11-13)**: o projeto de produção `qqgzbuaizprpmjeozzis` fica em
  **us-east-1 (EUA)**; não foi possível criar o projeto em São Paulo na conta. Há, portanto, **transferência
  internacional** de dados pessoais (operadores e, durante a execução, clientes em `clients_temp`), que o Bloco F
  precisa enquadrar no art. 33 (cláusulas-padrão/DPA do Supabase) e registrar no RIPD. [VALIDAR]
- **Encarregado**: nomear e publicar o canal de contato (art. 41).

## 2. Finalidade e bases legais [VALIDAR]

| Tratamento | Finalidade | Bases legais possíveis (não presumir consentimento) |
|---|---|---|
| Dados do cliente no formulário | gerar a proposta de crédito consignado solicitada | execução de contrato/procedimentos preliminares a pedido do titular (art. 7º, V); cumprimento de obrigação legal/regulatória (art. 7º, II); proteção do crédito (art. 7º, X) — conforme análise |
| Resultado da proposta (nº de adesão, status, datas) | registro operacional, comprovação e auditoria | legítimo interesse (art. 7º, IX) com teste de balanceamento; obrigação legal/regulatória |
| Dados dos operadores (nome, e-mail, logs de acesso) | controle de acesso, segurança, rastreabilidade | legítimo interesse; execução de contrato de trabalho/prestação |

Se o formulário mapeado incluir **dados sensíveis** (art. 5º, II) — por exemplo, saúde em benefício por
incapacidade — aplicar o art. 11 e reavaliar todo o fluxo.

## 3. Categorias de dados

- **Cliente**: definidas no mapeamento do Consig (provavelmente identificação, CPF, dados do benefício/matrícula,
  dados bancários para crédito). Existem **somente** em `clients_temp` e na memória do PC do backoffice durante
  a execução. Também passam pela tela do Consig no Chrome controlado (perfil local do app).
- **Operadores**: nome, e-mail, código, papel, registros de auditoria por ID.
- **Não coletados**: documentos digitalizados (não há upload nesta fase).

## 4. Minimização e retenção

| Dado | Prazo | Mecanismo |
|---|---|---|
| Payload do cliente (`clients_temp`) | até a conclusão; se não concluir, **72 h** | exclusão na mesma transação do resultado; `pg_cron` a cada 15 min |
| `payload_fingerprint` (hash SHA-256 do payload — dado pseudonimizado) | apagado junto com o payload | mesma rotina |
| Solicitação, resultado mínimo, tentativas, notificações | **90 dias** após finalizar [VALIDAR — pode ser curto para registros de crédito] | `run_retention` |
| Auditoria | **90 dias** [VALIDAR] | `run_retention` |
| Logs técnicos do desktop | 30 dias (arquivos diários) | rotação local |
| Histórico do `pg_cron` | 7 dias | job diário |
| Perfil do Chrome do backoffice | enquanto instalado | contém cookies/sessão do Consig; **definir rotina de limpeza** [VALIDAR] |

Não há e-mail de resultado: o e-mail do operador não é usado para avisos. A proposta gerada aparece só no portal
(referência, número de adesão, status e data/hora), para o remetente e o proprietário, via RLS.

### Limitações da exclusão (transparência)

Excluir uma linha **não** apaga imediatamente: backups diários do Supabase (retidos conforme o plano), WAL e
réplicas de recuperação, logs do provedor (API/Postgres, que podem registrar parâmetros de chamadas RPC),
e telas/cache do Chrome no PC do backoffice. Esses dados expiram pelos ciclos do
provedor (consultar a política vigente do plano contratado). Mitigações: dados em texto puro **apenas** em
`clients_temp`; não registrar payload em logs próprios; preferir região e plano com retenção de backup conhecida.

## 5. Direitos dos titulares (art. 18)

Procedimento sugerido: o titular contata o encarregado → identificação por canal seguro → busca pelo
`public_ref` ou, enquanto existir, pelo dado em `clients_temp` (consulta manual pelo DBA, registrada em
auditoria) → resposta em até 15 dias (art. 19). Como os dados do cliente são excluídos logo após a proposta, na
maioria dos casos a resposta será que não há dados retidos pelo sistema (o banco/Consig mantém os seus).

## 6. Segurança (art. 46) e incidentes (art. 48)

Medidas em `SECURITY.md`. Em incidente com risco relevante: conter (pausar fila, revogar acessos), avaliar
escopo via auditoria, registrar, comunicar a ANPD e titulares conforme a Resolução CD/ANPD nº 15/2024
(prazo de 3 dias úteis), e revisar controles.

## 7. Relatório de Impacto (RIPD) [VALIDAR]

Recomendado elaborar antes da produção: tratamento automatizado de dados financeiros/pessoais em volume,
uso de IA local para interpretar telas que podem conter dados pessoais, e dependência de provedores
estrangeiros. A IA **não** toma decisões sobre o titular (art. 20): só sugere recuperação técnica de tela,
com validação determinística e intervenção humana.

## 8. Checklist antes de dados reais

- [ ] Papéis de controlador/operador definidos e contratos assinados
- [ ] Bases legais documentadas por finalidade
- [ ] Prazos de retenção aprovados (substituir 90 dias se necessário em `app_settings`)
- [ ] Região do Supabase (hoje us-east-1, transferência internacional) e política de backup verificadas
- [ ] RIPD concluído
- [ ] Pentest e revisão de código independentes
- [ ] Treinamento dos operadores e do backoffice
