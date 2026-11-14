"""Executor de jobs: roda as etapas de um fluxo com timeouts, cancelamento e regras de segurança.

Garantias:
1. Um job por vez no motor (além do bloqueio no banco e do lock da sessão).
2. Antes da primeira etapa com efeito no Consig, o desktop precisa confirmar o registro do
   "ponto sem retorno" no banco. Sem confirmação, a etapa não roda.
3. Depois do ponto sem retorno, qualquer problema vira "escalated" (confirmação humana); nunca
   há nova tentativa automática, para não gerar proposta duplicada.
4. Etapas nunca são repetidas automaticamente pelo executor: tela não prevista vai para decisão humana.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Any

from . import logs
from .errors import EngineError, HostRejected, JobCancelled, StepTimeout, UnexpectedScreen
from .protocol import JobEvent, JobExecuteParams
from .session import ConsigSession
from .workflow import ProposalResult, Step, StepContext, Workflow

Emit = Callable[[JobEvent], Awaitable[None]]
ConfirmSideEffect = Callable[[str, str], Awaitable[bool]]



class NeedsHuman(EngineError):
    code = "NEEDS_HUMAN"
    retryable = False

    def __init__(self, reason_code: str, message: str = "") -> None:
        super().__init__(message or reason_code)
        self.reason_code = reason_code


class JobExecutor:
    def __init__(
        self,
        emit: Emit,
        confirm_side_effect: ConfirmSideEffect,
        heartbeat_s: float = 30,
    ) -> None:
        self._emit = emit
        self._confirm = confirm_side_effect
        self._heartbeat_s = heartbeat_s
        self._task: asyncio.Task[None] | None = None
        self._job_id: str | None = None

    @property
    def current_job(self) -> str | None:
        return self._job_id

    def start(self, params: JobExecuteParams, workflow: Workflow, session: ConsigSession | None) -> None:
        if self._task is not None and not self._task.done():
            raise EngineError("engine busy", code="ENGINE_BUSY")
        workflow.validate()
        self._job_id = params.job_id
        self._task = asyncio.create_task(self._run(params, workflow, session))

    async def cancel(self, job_id: str) -> bool:
        if self._job_id != job_id or self._task is None or self._task.done():
            return False
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        return True

    async def wait(self) -> None:
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _event(self, job_id: str, type_: str, step: str | None = None, **data: Any) -> None:
        await self._emit(JobEvent(job_id=job_id, type=type_, step=step, data=data))  # type: ignore[arg-type]

    async def _heartbeat(self, job_id: str, ctx: dict[str, str | None]) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_s)
            await self._event(job_id, "heartbeat", ctx.get("step"))

    async def _run(self, p: JobExecuteParams, wf: Workflow, session: ConsigSession | None) -> None:
        ctx = StepContext(p.job_id, p.request_id, p.public_ref, p.attempt, p.payload, p.fields, session)
        progress: dict[str, str | None] = {"step": None}
        side_effect = False
        hb = asyncio.create_task(self._heartbeat(p.job_id, progress))
        logs.info("job started", job_id=p.job_id, workflow=wf.id, attempt=p.attempt)
        try:
            async with asyncio.timeout(p.deadline_s):
                lock = session.lock if (wf.needs_session and session) else contextlib.nullcontext()
                async with lock:
                    result: ProposalResult | None = None
                    for step in wf.steps:
                        progress["step"] = step.name
                        await self._event(p.job_id, "step_started", step.name)
                        if step.side_effect and not side_effect:
                            if not await self._confirm_point_of_no_return(p.job_id, step.name):
                                raise HostRejected(step=step.name)
                            side_effect = True
                        result = await self._run_step(step, ctx) or result
            if result is None:
                raise NeedsHuman("NO_RESULT", "fluxo terminou sem número de adesão")
            await self._event(p.job_id, "completed", progress["step"],
                              adhesion_number=result.adhesion_number, result_status=result.result_status,
                              external_operation_id=result.external_operation_id)
            logs.info("job completed", job_id=p.job_id)
        except asyncio.CancelledError:
            await self._finish_error(p.job_id, progress["step"], side_effect, JobCancelled())
        except TimeoutError:
            await self._finish_error(p.job_id, progress["step"], side_effect, StepTimeout("job deadline"))
        except EngineError as e:
            await self._finish_error(p.job_id, progress["step"], side_effect, e)
        except Exception as e:  # noqa: BLE001 — erro inesperado de etapa
            logs.error("step crashed", job_id=p.job_id, step=progress["step"], error=type(e).__name__)
            err = EngineError(type(e).__name__)
            err.code = "STEP_CRASHED"
            await self._finish_error(p.job_id, progress["step"], side_effect, err)
        finally:
            hb.cancel()
            self._job_id = None

    async def _confirm_point_of_no_return(self, job_id: str, step: str) -> bool:
        try:
            return bool(await self._confirm(job_id, step))
        except Exception as e:  # noqa: BLE001 — sem confirmação, não executa
            logs.warning("side effect not confirmed", job_id=job_id, step=step, error=type(e).__name__)
            return False

    async def _finish_error(self, job_id: str, step: str | None, side_effect: bool, e: EngineError) -> None:
        if isinstance(e, NeedsHuman) or side_effect:
            code = e.reason_code if isinstance(e, NeedsHuman) else e.code
            logs.warning("job escalated", job_id=job_id, step=step, code=code)
            await self._event(job_id, "escalated", step, reason_code=code, message=str(e)[:300])
        else:
            logs.warning("job failed", job_id=job_id, step=step, code=e.code, retryable=e.retryable)
            await self._event(job_id, "failed", step, error_code=e.code, message=str(e)[:300], retryable=e.retryable)

    async def _run_step(self, step: Step, ctx: StepContext) -> ProposalResult | None:
        try:
            return await asyncio.wait_for(step.run(ctx), step.timeout_s)
        except TimeoutError as e:
            raise StepTimeout(f"step {step.name} timed out", step=step.name) from e
        except UnexpectedScreen as e:
            # Sem IA no MVP: tela não prevista sempre vai para decisão humana.
            raise NeedsHuman("UNEXPECTED_SCREEN", f"tela não prevista em {step.name}") from e
