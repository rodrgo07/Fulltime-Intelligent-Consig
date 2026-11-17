"""Registro de fluxos.

PRODUCTION_FLOW fica None até o fluxo real do Consig (código Selenium mapeado) ser encaixado.
Sem fluxo, o robô não reserva nenhum job. O fluxo FALSO existe só para teste ponta a ponta e só liga com
FIC_FAKE_FLOW=1; ele nunca abre o Consig.
"""

from __future__ import annotations

import os
import time
from typing import Any

from .steps import Flow, ProposalResult, Step, StepContext, UnexpectedScreen

PRODUCTION_FLOW: Flow | None = None


class FakeFill(Step):
    name = "preencher_falso"

    def run(self, driver: Any, ctx: StepContext) -> None:
        ctx.require("documento")
        time.sleep(float(os.environ.get("FIC_FAKE_DELAY", "0")))


class FakeSubmit(Step):
    name = "enviar_falso"
    side_effect = True

    def run(self, driver: Any, ctx: StepContext) -> ProposalResult:
        if os.environ.get("FIC_FAKE_SCENARIO") == "unexpected_after_submit":
            raise UnexpectedScreen("tela inesperada depois do envio (cenário falso)")
        return ProposalResult(adhesion_number=f"FALSO-{ctx.public_ref[-8:]}")


def fake_flow() -> Flow:
    return Flow(id="fake", version=1, steps=[FakeFill(), FakeSubmit()])


def select_flow() -> Flow | None:
    if os.environ.get("FIC_FAKE_FLOW") == "1":
        return fake_flow()
    return PRODUCTION_FLOW
