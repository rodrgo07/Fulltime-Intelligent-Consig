"""Definição de fluxos de automação em etapas.

Cada etapa é uma classe pequena e testável. Etapas novas do Consig são adicionadas criando uma Step
e incluindo-a no fluxo registrado — sem alterar executor, protocolo ou desktop.

Regras:
- Etapas usam seletores/elementos (Playwright), nunca coordenadas fixas.
- side_effect=True marca a etapa que pode criar/alterar algo no Consig (ponto sem retorno):
  antes dela o executor exige que o desktop registre o marco no banco.
- allowed_recoveries limita o que a IA pode sugerir para essa etapa.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, ClassVar

from .session import ConsigSession


class Recovery(StrEnum):
    """Ações de recuperação que a IA pode SUGERIR. A execução é sempre do código determinístico."""

    RETRY_STEP = "retry_step"
    WAIT_AND_RETRY = "wait_and_retry"
    ESCALATE = "escalate"


@dataclass
class StepContext:
    job_id: str
    request_id: str
    public_ref: str
    attempt: int
    payload: dict[str, Any]
    fields: list[dict[str, Any]]
    session: ConsigSession | None
    state: dict[str, Any] = field(default_factory=dict)  # dados entre etapas (sem persistência)

    def require(self, key: str) -> Any:
        from .errors import InvalidJobData

        if key not in self.payload or self.payload[key] in (None, ""):
            raise InvalidJobData(f"missing field {key}", field=key)
        return self.payload[key]


@dataclass
class ProposalResult:
    adhesion_number: str
    result_status: str
    external_operation_id: str | None = None


class Step:
    name: ClassVar[str]
    side_effect: ClassVar[bool] = False
    timeout_s: ClassVar[float] = 60
    allowed_recoveries: ClassVar[frozenset[Recovery]] = frozenset({Recovery.ESCALATE})

    async def run(self, ctx: StepContext) -> ProposalResult | None:
        raise NotImplementedError


@dataclass
class Workflow:
    id: str
    version: int
    steps: list[Step]
    needs_session: bool = True

    def validate(self) -> None:
        names = [s.name for s in self.steps]
        if len(names) != len(set(names)):
            raise ValueError(f"duplicate step names in {self.id}")
        if not self.steps:
            raise ValueError(f"workflow {self.id} has no steps")


WorkflowFactory = Callable[[], Workflow]
