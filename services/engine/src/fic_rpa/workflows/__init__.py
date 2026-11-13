"""Registro de fluxos de produção.

VAZIO de propósito: o processo de geração de propostas no Consig ainda não foi mapeado.
Nenhuma tela, seletor ou campo do Banco BMG é inventado aqui. Enquanto não houver um fluxo
registrado, o motor informa workflow_ready=false e o desktop NÃO reserva solicitações
(elas permanecem "Aguardando processamento").

Para adicionar o fluxo real: criar fic_rpa/workflows/consig_proposal.py com as Steps mapeadas e
registrar aqui: PRODUCTION_WORKFLOWS["consig_proposal"] = build_consig_proposal
"""

from __future__ import annotations

from ..workflow import WorkflowFactory

ACTIVE_WORKFLOW_ID = "consig_proposal"

PRODUCTION_WORKFLOWS: dict[str, WorkflowFactory] = {}
