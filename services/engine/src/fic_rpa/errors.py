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


class UnexpectedScreen(EngineError):
    """Tela/mensagem não prevista pelas regras determinísticas: sempre vai para decisão humana."""

    code = "UNEXPECTED_SCREEN"
    retryable = False

    def __init__(self, summary: str) -> None:
        # Só um resumo técnico, sem texto da tela (pode conter dados pessoais).
        super().__init__(summary)
