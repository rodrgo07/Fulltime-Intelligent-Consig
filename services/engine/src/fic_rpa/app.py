"""Liga protocolo, sessão, executor e IA. Cada método RPC valida seus parâmetros (pydantic)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fic_ai.manifest import load_manifest
from fic_ai.service import AiService

from . import CONTRACT_VERSION, ENGINE_VERSION, logs
from .errors import EngineError, WorkflowNotReady
from .executor import JobExecutor
from .protocol import AiConfigureParams, AiPullParams, HelloParams, JobEvent, JobExecuteParams, JobRef, SessionOpenParams
from .rpc import RpcServer
from .session import ConsigSession, SessionState
from .workflow import WorkflowFactory
from .workflows import ACTIVE_WORKFLOW_ID, PRODUCTION_WORKFLOWS


class Engine:
    def __init__(self, rpc: RpcServer, data_dir: Path, workflows: dict[str, WorkflowFactory] | None = None,
                 session: ConsigSession | None = None, ai: AiService | None = None) -> None:
        self.rpc = rpc
        self.data_dir = data_dir
        self.workflows = PRODUCTION_WORKFLOWS if workflows is None else workflows
        self.session = session or ConsigSession(data_dir / "chrome-profile")
        self.ai = ai or AiService(data_dir / "ialocal", load_manifest())
        self.executor = JobExecutor(self._emit, self._confirm_side_effect, advisor=self.ai)
        self._install_task: asyncio.Task[None] | None = None
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
            "ai.status": self.ai_status,
            "ai.configure": self.ai_configure,
            "ai.install_runtime": self.ai_install,
            "ai.pull_model": self.ai_pull,
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
            "ai": self.ai.status()["state"],
        }

    async def shutdown(self, _: dict[str, Any]) -> dict[str, Any]:
        self._stop.set()
        return {"ok": True}

    async def wait_stopped(self) -> None:
        await self._stop.wait()
        if self.executor.current_job:
            await self.executor.cancel(self.executor.current_job)
        await self.ai.cancel()
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

    # ---------------------------------------------------------------- IA
    async def ai_status(self, _: dict[str, Any]) -> dict[str, Any]:
        st = self.ai.status()
        st["installing"] = self._install_task is not None and not self._install_task.done()
        return st

    async def ai_configure(self, p: dict[str, Any]) -> dict[str, Any]:
        params = AiConfigureParams.model_validate(p)
        if params.model and params.model not in {c.name for c in self.ai.manifest.model_candidates}:
            raise EngineError("model not allowed", code="MODEL_NOT_IN_MANIFEST")
        s = self.ai.settings
        s.enabled, s.model, s.timeout_s = params.enabled, params.model, params.timeout_s
        s.min_free_ram_mb, s.max_cpu_percent, s.min_confidence = (
            params.min_free_ram_mb, params.max_cpu_percent, params.min_confidence)
        if not params.enabled:
            await self.ai.cancel()
        logs.info("ai configured", enabled=params.enabled, model=params.model)
        return self.ai.status()

    async def ai_install(self, _: dict[str, Any]) -> dict[str, Any]:
        from fic_ai import installer

        if self._install_task is None or self._install_task.done():
            async def run() -> None:
                try:
                    await asyncio.to_thread(installer.install, self.ai.ialocal, self.ai.manifest.runtime)
                except Exception as e:  # noqa: BLE001
                    self.ai.last_error = str(e)[:100]
                    logs.error("ai runtime install failed", error=str(e)[:100])
            self._install_task = asyncio.create_task(run())
        return {"installing": True}

    async def ai_pull(self, p: dict[str, Any]) -> dict[str, Any]:
        params = AiPullParams.model_validate(p)
        if not self.ai.runtime_installed():
            raise EngineError("runtime missing", code="AI_RUNTIME_MISSING")
        try:
            await self.ai.pull_model(params.model)
        except ValueError as e:
            raise EngineError(str(e), code="MODEL_NOT_IN_MANIFEST") from e
        return {"ok": True, "model": params.model}
