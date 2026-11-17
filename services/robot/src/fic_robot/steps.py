"""Fluxo do Consig como lista de etapas.

O código Selenium mapeado entra como `run(driver, ctx)` de cada etapa. Só a etapa que submete a proposta
tem `side_effect = True`; antes dela o robô registra o ponto sem retorno no banco.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, ClassVar


class Recovery(StrEnum):
    """Ações que a IA local pode sugerir (lista fechada). Quem executa é sempre o código."""

    RETRY_STEP = "retry_step"
    WAIT_AND_RETRY = "wait_and_retry"
    ESCALATE = "escalate"


class RobotError(Exception):
    code = "ROBOT_ERROR"
    retryable = True


class InvalidJobData(RobotError):
    code = "INVALID_JOB_DATA"
    retryable = False


class SessionUnavailable(RobotError):
    code = "SESSION_UNAVAILABLE"
    retryable = True


class UnexpectedScreen(RobotError):
    code = "UNEXPECTED_SCREEN"
    retryable = False


@dataclass
class StepContext:
    job_id: str
    request_id: str
    public_ref: str
    attempt: int
    payload: dict[str, Any]  # dado pessoal: só em memória, nunca logar
    fields: list[dict[str, Any]]
    state: dict[str, Any] = field(default_factory=dict)

    def require(self, key: str) -> Any:
        if self.payload.get(key) in (None, ""):
            raise InvalidJobData(f"campo obrigatório ausente: {key}")
        return self.payload[key]


@dataclass(frozen=True)
class ProposalResult:
    adhesion_number: str
    result_status: str = "GERADA"
    external_operation_id: str | None = None


class Step:
    name: ClassVar[str]
    side_effect: ClassVar[bool] = False
    timeout_s: ClassVar[float] = 60
    allowed_recoveries: ClassVar[frozenset[Recovery]] = frozenset({Recovery.ESCALATE})

    def run(self, driver: Any, ctx: StepContext) -> ProposalResult | None:
        raise NotImplementedError


@dataclass
class Flow:
    id: str
    version: int
    steps: list[Step]

    def __post_init__(self) -> None:
        names = [s.name for s in self.steps]
        if not names:
            raise ValueError(f"fluxo {self.id} sem etapas")
        if len(names) != len(set(names)):
            raise ValueError(f"fluxo {self.id} com etapas repetidas")
        if sum(1 for s in self.steps if s.side_effect) > 1:
            raise ValueError(f"fluxo {self.id} com mais de uma etapa com efeito")
