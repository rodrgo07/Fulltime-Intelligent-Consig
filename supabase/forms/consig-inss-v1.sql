-- Formulário da digitação no ConsigMais (fluxo `consig` do robô). Rodar uma vez no SQL Editor do projeto.
-- Os nomes dos campos são o contrato com services/robot/src/fic_robot/consig.py: `cpf` e `entidade`.
-- Desativa o formulário atual e ativa este como a próxima versão (as solicitações antigas mantêm a versão delas).
-- Para mais entidades, publique uma versão nova com outras opções em `entidade` (valor = código do ConsigMais).
begin;
update public.form_definitions set active = false where active;
insert into public.form_definitions (version, title, fields, active)
select coalesce(max(version), 0) + 1, 'Proposta de consignado', $json$[
  {"key": "cpf", "label": "CPF do cliente", "type": "cpf", "required": true},
  {"key": "entidade", "label": "Entidade", "type": "select", "required": true,
   "options": [{"value": "1581", "label": "1581 - INSS"}]}
]$json$::jsonb, true
from public.form_definitions;
commit;
