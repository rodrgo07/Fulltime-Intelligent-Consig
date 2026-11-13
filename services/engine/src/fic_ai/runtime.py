"""Processo do Ollama portátil: sobe sob demanda, roda uma inferência e é encerrado.

- Escuta só em 127.0.0.1, porta aleatória.
- Prioridade baixa no Windows: Consig e Windows têm preferência.
- keep_alive=0 + encerramento do processo: o modelo sai da memória ao terminar.
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
from pathlib import Path
from typing import Any

import httpx
import psutil

from fic_rpa import logs


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class OllamaProcess:
    def __init__(self, executable: Path, models_dir: Path) -> None:
        self._exe = executable
        self._models = models_dir
        self._proc: subprocess.Popen[bytes] | None = None
        self.base_url = ""

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def start(self, ready_timeout: float = 60) -> None:
        if self.running:
            return
        port = _free_port()
        self.base_url = f"http://127.0.0.1:{port}"
        env = {
            **{k: v for k, v in os.environ.items() if k.upper() in {"SYSTEMROOT", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"}},
            "OLLAMA_HOST": f"127.0.0.1:{port}",
            "OLLAMA_MODELS": str(self._models),
            "OLLAMA_KEEP_ALIVE": "0",
            "OLLAMA_NUM_PARALLEL": "1",
            "OLLAMA_MAX_LOADED_MODELS": "1",
            "OLLAMA_NOPRUNE": "1",
        }
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        self._proc = subprocess.Popen(  # noqa: S603 — executável verificado por hash, sem shell
            [str(self._exe), "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, creationflags=flags,
        )
        async with httpx.AsyncClient(timeout=2) as c:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + ready_timeout
            while loop.time() < deadline:
                if not self.running:
                    raise RuntimeError("ollama exited during startup")
                try:
                    if (await c.get(f"{self.base_url}/api/version")).status_code == 200:
                        logs.info("ai runtime started")
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.5)
        await self.stop()
        raise RuntimeError("ollama not ready")

    async def stop(self) -> None:
        if self._proc is None:
            return
        try:
            parent = psutil.Process(self._proc.pid)
            for child in parent.children(recursive=True):  # runners que carregam o modelo
                child.kill()
            parent.kill()
        except psutil.NoSuchProcess:
            pass
        self._proc.wait(timeout=10)
        self._proc = None
        logs.info("ai runtime stopped")

    async def chat(self, model: str, prompt: str, images_b64: list[str], schema: dict[str, Any], timeout: float) -> str:
        body = {
            "model": model,
            "stream": False,
            "keep_alive": 0,
            "format": schema,
            "options": {"temperature": 0, "num_thread": max(1, (os.cpu_count() or 2) // 2)},
            "messages": [{"role": "user", "content": prompt, "images": images_b64}],
        }
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{self.base_url}/api/chat", json=body)
            r.raise_for_status()
            return str(r.json()["message"]["content"])

    async def pull(self, model: str, timeout: float = 3600) -> None:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{self.base_url}/api/pull", json={"model": model, "stream": False})
            r.raise_for_status()
