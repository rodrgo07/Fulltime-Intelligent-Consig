"""Contrato JSON-RPC v1 entre o app desktop (Rust) e o motor (ver docs/API_CONTRACT.md §4).

Fixtures em packages/contracts/fixtures/engine-rpc/ são validadas aqui e no lado Rust.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class HelloParams(Strict):
    contract_version: int


class JobExecuteParams(Strict):
    job_id: str = Field(min_length=1, max_length=64)
    request_id: str = Field(min_length=1, max_length=64)
    public_ref: str = Field(min_length=1, max_length=40)
    attempt: int = Field(ge=1)
    form_version: int = Field(ge=1)
    fields: list[dict[str, Any]]
    payload: dict[str, Any]
    deadline_s: float = Field(default=900, gt=0, le=7200)


class JobRef(Strict):
    job_id: str = Field(min_length=1, max_length=64)


class AiConfigureParams(Strict):
    enabled: bool
    model: str | None = Field(default=None, max_length=100)
    timeout_s: float = Field(default=90, gt=0, le=600)
    min_free_ram_mb: int = Field(default=1500, ge=256)
    max_cpu_percent: float = Field(default=85, gt=0, le=100)
    min_confidence: float = Field(default=0.8, ge=0.5, le=1)


class AiPullParams(Strict):
    model: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._:-]*$")


class SessionOpenParams(Strict):
    start_url: str | None = Field(default=None, max_length=500, pattern=r"^https://")


EventType = Literal["step_started", "heartbeat", "completed", "failed", "escalated"]


class JobEvent(Strict):
    """Notificação job.event (motor → desktop)."""

    job_id: str
    type: EventType
    step: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class SideEffectConfirm(Strict):
    """Chamada host.confirm_side_effect (motor → desktop). Resposta: {"confirmed": bool}."""

    job_id: str
    step: str
