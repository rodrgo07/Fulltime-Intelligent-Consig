from __future__ import annotations

import asyncio
from typing import Any

import pytest

from fic_rpa.errors import Observation, UnexpectedScreen
from fic_rpa.executor import Advice
from fic_rpa.protocol import JobEvent, JobExecuteParams
from fic_rpa.workflow import ProposalResult, Recovery, Step, StepContext, Workflow

# Etapas FICTÍCIAS usadas só nos testes do executor. Não representam o Consig.


class OkStep(Step):
    name = "preparar"

    async def run(self, ctx: StepContext) -> None:
        ctx.state["ran"] = ctx.state.get("ran", []) + [self.name]


class ResultStep(Step):
    name = "resultado"

    async def run(self, ctx: StepContext) -> ProposalResult:
        ctx.state["ran"] = ctx.state.get("ran", []) + [self.name]
        return ProposalResult(adhesion_number="ADE-FAKE-1", result_status="GERADA")


class SideEffectStep(Step):
    name = "efeito"
    side_effect = True

    async def run(self, ctx: StepContext) -> None:
        ctx.state["ran"] = ctx.state.get("ran", []) + [self.name]


class FlakyScreenStep(Step):
    """Mostra uma tela inesperada nas primeiras N execuções."""

    name = "tela_instavel"
    allowed_recoveries = frozenset({Recovery.RETRY_STEP, Recovery.WAIT_AND_RETRY, Recovery.ESCALATE})

    def __init__(self, failures: int = 1, side_effect: bool = False) -> None:
        self.failures = failures
        self.calls = 0
        if side_effect:
            self.side_effect = True  # type: ignore[misc]

    async def run(self, ctx: StepContext) -> None:
        self.calls += 1
        if self.calls <= self.failures:
            raise UnexpectedScreen(Observation(summary="popup", visible_text="Aguarde..."))


class SlowStep(Step):
    name = "lenta"
    timeout_s = 0.05

    async def run(self, ctx: StepContext) -> None:
        await asyncio.sleep(1)


class BoomStep(Step):
    name = "quebra"

    async def run(self, ctx: StepContext) -> None:
        raise RuntimeError("bug")


def wf(*steps: Step) -> Workflow:
    return Workflow(id="teste", version=1, steps=list(steps), needs_session=False)


def params(job_id: str = "job-1", deadline: float = 5) -> JobExecuteParams:
    return JobExecuteParams(job_id=job_id, request_id="req-1", public_ref="FIC-261112-AAAAAAAA", attempt=1,
                            form_version=1, fields=[], payload={"documento": "52998224725"}, deadline_s=deadline)


class Recorder:
    def __init__(self, confirm: bool = True) -> None:
        self.events: list[JobEvent] = []
        self.confirm = confirm
        self.confirm_calls: list[tuple[str, str]] = []

    async def emit(self, ev: JobEvent) -> None:
        self.events.append(ev)

    async def confirm_side_effect(self, job_id: str, step: str) -> bool:
        self.confirm_calls.append((job_id, step))
        return self.confirm

    def last(self) -> JobEvent:
        return [e for e in self.events if e.type not in ("step_started", "heartbeat")][-1]


class FakeAdvisor:
    def __init__(self, action: Recovery | str | None, confidence: float = 0.95) -> None:
        self.action = action
        self.confidence = confidence
        self.min_confidence = 0.8
        self.calls = 0

    async def advise(self, step: str, allowed: list[str], observation: Observation) -> Advice | None:
        self.calls += 1
        if self.action is None:
            return None
        return Advice(self.action, self.confidence, "teste")  # type: ignore[arg-type]


@pytest.fixture
def rec() -> Recorder:
    return Recorder()


class FakeRuntime:
    def __init__(self, reply: str = '{"situation":"carregando","action":"retry_step","confidence":0.9}') -> None:
        self.running = False
        self.reply = reply
        self.starts = 0
        self.stops = 0
        self.delay = 0.0

    async def start(self, ready_timeout: float = 60) -> None:
        self.starts += 1
        self.running = True

    async def stop(self) -> None:
        self.stops += 1
        self.running = False

    async def chat(self, model: str, prompt: str, images_b64: list[str], schema: dict[str, Any], timeout: float) -> str:
        await asyncio.sleep(self.delay)
        return self.reply

    async def pull(self, model: str, timeout: float = 3600) -> None:
        return None
