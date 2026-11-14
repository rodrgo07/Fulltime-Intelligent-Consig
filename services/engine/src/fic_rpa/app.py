"""Liga protocolo, sessão e executor. Cada método RPC valida seus parâmetros (pydantic)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from . import CONTRACT_VERSION, ENGINE_VERSION, logs
from .errors import EngineError, WorkflowNotReady
from .executor import JobExecutor
from .protocol import HelloParams, JobEvent, JobExecuteParams, JobRef, SessionOpenParams
from .rpc import RpcServer
from .session import ConsigSession, SessionState
from .workflow import WorkflowFactory
from .workflows import ACTIVE_WORKFLOW_ID, PRODUCTION_WORKFLOWS


class Engine:
    def __init__(self, rpc: RpcServer, data_dir: Path, workflows: dict[str, WorkflowFactory] | None = None,
                 session: ConsigSession | None = None) -> None:
        self.rpc = rpc
        self.data_dir = data_dir
        self.workflows = PRODUCTION_WORKFLOWS if workflows is None else workflows
        self.session = session or ConsigSession(data_dir / "chrome-profile")
        self.executor = JobExecutor(self._emit, self._confirm_side_effect)
        self._stop = asyncio.Event()
        for name, fn in {
            "engine.hello": self.hello,
            "engine.health": self.health,
            "engine.shutdown": self.shutdown,
            "session.open": self.session_open,
            "session.status": self.session_status,
            "session.close": self.session_close,
            "job.execute": self.job_execute,
            "job.cancel": self.job_cancel,
        }.items():
            rpc.register(name, fn)

    @property
    def workflow_ready(self) -> bool:
        return ACTIVE_WORKFLOW_ID in self.workflows

    async def _emit(self, ev: JobEvent) -> None:
        await self.rpc.notify("job.event", ev.model_dump())

    async def _confirm_side_effect(self, job_id: str, step: str) -> bool:
        res = await self.rpc.call_host("host.confirm_side_effect", {"job_id": job_id, "step": step}, timeout=30)
        return bool(isinstance(res, dict) and res.get("confirmed") is True)

    # ---------------------------------------------------------------- engine
    async def hello(self, p: dict[str, Any]) -> dict[str, Any]:
        params = HelloParams.model_validate(p)
        if params.contract_version != CONTRACT_VERSION:
            raise EngineError("contract mismatch", code="CONTRACT_MISMATCH", expected=CONTRACT_VERSION)
        return {"engine_version": ENGINE_VERSION, "contract_version": CONTRACT_VERSION,
                "capabilities": {"workflow_ready": self.workflow_ready, "workflow_id": ACTIVE_WORKFLOW_ID}}

    async def health(self, _: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": "ok",
            "workflow_ready": self.workflow_ready,
            "session": (await self.session.status()).value,
            "current_job": self.executor.current_job,
        }

    async def shutdown(self, _: dict[str, Any]) -> dict[str, Any]:
        self._stop.set()
        return {"ok": True}

    async def wait_stopped(self) -> None:
        await self._stop.wait()
        if self.executor.current_job:
            await self.executor.cancel(self.executor.current_job)
        await self.session.close()

    # ---------------------------------------------------------------- sessão
    async def session_open(self, p: dict[str, Any]) -> dict[str, Any]:
        params = SessionOpenParams.model_validate(p)
        return {"state": (await self.session.open(params.start_url)).value}

    async def session_status(self, _: dict[str, Any]) -> dict[str, Any]:
        return {"state": (await self.session.status()).value}

    async def session_close(self, _: dict[str, Any]) -> dict[str, Any]:
        if self.executor.current_job:
            raise EngineError("job running", code="ENGINE_BUSY")
        await self.session.close()
        return {"state": SessionState.CLOSED.value}

    # ---------------------------------------------------------------- jobs
    async def job_execute(self, p: dict[str, Any]) -> dict[str, Any]:
        params = JobExecuteParams.model_validate(p)
        factory = self.workflows.get(ACTIVE_WORKFLOW_ID)
        if factory is None:
            raise WorkflowNotReady("fluxo do Consig ainda não implementado")
        workflow = factory()
        if workflow.needs_session and await self.session.status() != SessionState.AUTHENTICATED:
            raise EngineError("consig session not authenticated", code="SESSION_UNAVAILABLE")
        self.executor.start(params, workflow, self.session)
        return {"accepted": True, "job_id": params.job_id}

    async def job_cancel(self, p: dict[str, Any]) -> dict[str, Any]:
        return {"cancelled": await self.executor.cancel(JobRef.model_validate(p).job_id)}

