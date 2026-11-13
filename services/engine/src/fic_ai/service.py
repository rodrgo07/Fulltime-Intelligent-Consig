"""Fachada da IA local usada pelo motor RPA (implementa o protocolo Advisor do executor)."""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import psutil

from fic_rpa import logs
from fic_rpa.errors import Observation
from fic_rpa.executor import Advice
from fic_rpa.workflow import Recovery

from . import hardware, installer
from .interpret import build_prompt, parse, response_schema
from .manifest import Manifest
from .runtime import OllamaProcess


@dataclass
class AiSettings:
    enabled: bool = False  # Privacy by Default: IA começa desligada
    model: str | None = None
    timeout_s: float = 90
    min_free_ram_mb: int = 1500
    max_cpu_percent: float = 85
    min_confidence: float = 0.8


class Runtime(Protocol):
    running: bool

    async def start(self, ready_timeout: float = 60) -> None: ...
    async def stop(self) -> None: ...
    async def chat(self, model: str, prompt: str, images_b64: list[str], schema: dict[str, Any], timeout: float) -> str: ...
    async def pull(self, model: str, timeout: float = 3600) -> None: ...


class AiService:
    def __init__(self, ialocal: Path, manifest: Manifest, runtime: Runtime | None = None) -> None:
        self.ialocal = ialocal
        self.manifest = manifest
        self.settings = AiSettings()
        self._runtime: Runtime = runtime or OllamaProcess(
            installer.runtime_executable(ialocal, manifest.runtime), ialocal / "models")
        self._lock = asyncio.Lock()  # uma inferência por vez
        self._busy = False
        self.last_error: str | None = None

    @property
    def min_confidence(self) -> float:
        return self.settings.min_confidence

    def runtime_installed(self) -> bool:
        return installer.is_installed(self.ialocal, self.manifest.runtime)

    def status(self) -> dict[str, Any]:
        hw = hardware.snapshot()
        rec = hardware.recommend(self.manifest.model_candidates, int(hw["total_ram_mb"]))
        if not self.settings.enabled:
            state = "disabled"
        elif not self.runtime_installed():
            state = "runtime_missing"
        elif not self.settings.model:
            state = "model_not_selected"
        else:
            state = "busy" if self._busy else "ready"
        return {
            "state": state,
            "enabled": self.settings.enabled,
            "model": self.settings.model,
            "runtime_version": self.manifest.runtime.version,
            "runtime_installed": self.runtime_installed(),
            "loaded": self._runtime.running,
            "hardware": hw,
            "recommended_model": rec.name if rec else None,
            "candidates": [c.model_dump() for c in self.manifest.model_candidates],
            "last_error": self.last_error,
        }

    def _resources_ok(self) -> str | None:
        vm = psutil.virtual_memory()
        if vm.available // 2**20 < self.settings.min_free_ram_mb:
            return "LOW_MEMORY"
        if psutil.cpu_percent(interval=0.3) > self.settings.max_cpu_percent:
            return "HIGH_CPU"
        return None

    async def advise(self, step: str, allowed: list[str], observation: Observation) -> Advice | None:
        """None = IA indisponível ou sem resposta confiável; o executor escala para humano."""
        if not self.settings.enabled or not self.settings.model or not self.runtime_installed():
            return None
        if self._lock.locked():
            return None  # não enfileira inferências
        async with self._lock:
            if reason := self._resources_ok():
                self.last_error = reason
                logs.warning("ai skipped", reason=reason)
                return None
            self._busy = True
            try:
                await self._runtime.start()
                images = [base64.b64encode(observation.screenshot_png).decode()] if observation.screenshot_png else []
                raw = await asyncio.wait_for(
                    self._runtime.chat(self.settings.model, build_prompt(step, allowed, observation.visible_text),
                                       images, response_schema(allowed), self.settings.timeout_s),
                    self.settings.timeout_s,
                )
                out = parse(raw, allowed)
                self.last_error = None if out else "UNPARSEABLE"
                if out is None:
                    return None
                logs.info("ai advice", step=step, action=out.action, confidence=round(out.confidence, 2))
                return Advice(Recovery(out.action), out.confidence, out.situation)
            except Exception as e:  # noqa: BLE001 — IA é opcional (inclui TimeoutError)
                self.last_error = type(e).__name__
                logs.warning("ai inference failed", error=type(e).__name__)
                return None
            finally:
                await self._runtime.stop()  # libera RAM sempre
                self._busy = False

    async def cancel(self) -> None:
        await self._runtime.stop()

    async def pull_model(self, model: str) -> None:
        if model not in {c.name for c in self.manifest.model_candidates}:
            raise ValueError("MODEL_NOT_IN_MANIFEST")
        async with self._lock:
            try:
                await self._runtime.start()
                await self._runtime.pull(model)
            finally:
                await self._runtime.stop()
