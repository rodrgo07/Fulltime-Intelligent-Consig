"""Erros do motor com códigos estáveis (mesmos códigos gravados em automation_jobs.error_code)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class EngineError(Exception):
    code = "ENGINE_ERROR"
    retryable = True

    def __init__(self, message: str = "", **data: Any) -> None:
        super().__init__(message or self.code)
        self.data = data


class WorkflowNotReady(EngineError):
    """Nenhum fluxo do Consig implementado/configurado — o job não deve ser reservado."""

    code = "WORKFLOW_NOT_READY"
    retryable = True


class SessionUnavailable(EngineError):
    """Sessão do Consig fechada, expirada ou não autenticada: requer login humano."""

    code = "SESSION_UNAVAILABLE"
    retryable = True


class BrowserMissing(EngineError):
    code = "BROWSER_MISSING"
    retryable = True


class StepTimeout(EngineError):
    code = "STEP_TIMEOUT"
    retryable = True


class InvalidJobData(EngineError):
    """Os dados da solicitação não atendem ao que a etapa exige. Repetir não resolve."""

    code = "INVALID_JOB_DATA"
    retryable = False


class JobCancelled(EngineError):
    code = "JOB_CANCELLED"
    retryable = False


class HostRejected(EngineError):
    """O app desktop não confirmou o registro do ponto sem retorno; a etapa não é executada."""

    code = "HOST_REJECTED_SIDE_EFFECT"
    retryable = True


@dataclass
class Observation:
    """Estado observado da tela. Pode conter dados pessoais: nunca logar, só usar localmente."""

    summary: str
    visible_text: str = ""
    screenshot_png: bytes | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class UnexpectedScreen(EngineError):
    """Tela/mensagem não prevista pelas regras determinísticas. Pode ser levada à IA local."""

    code = "UNEXPECTED_SCREEN"
    retryable = False

    def __init__(self, observation: Observation) -> None:
        super().__init__(observation.summary)
        self.observation = observation
