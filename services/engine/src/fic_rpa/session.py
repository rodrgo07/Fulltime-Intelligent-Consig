"""Sessão única e controlada do Consig no Google Chrome do backoffice.

- O login é SEMPRE feito por uma pessoa no navegador aberto pelo motor; nenhuma senha é armazenada.
- O perfil do Chrome é dedicado ao app (não usa o Chrome pessoal).
- Um único job usa a página por vez (lock), além da garantia no banco.
- Se o Consig está autenticado é decidido por um SessionProbe específico do Consig, que ainda NÃO
  foi mapeado: até lá o estado é "open_unverified" e o motor não reivindica jobs.
"""

from __future__ import annotations

import asyncio
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from . import logs
from .errors import BrowserMissing, SessionUnavailable


class SessionState(StrEnum):
    CLOSED = "closed"
    OPEN_UNVERIFIED = "open_unverified"  # navegador aberto; autenticação no Consig ainda não verificável
    AUTHENTICATED = "authenticated"
    EXPIRED = "expired"
    BROWSER_MISSING = "browser_missing"


class SessionProbe(Protocol):
    """Implementação específica do Consig (a ser criada no mapeamento): True/False/None (indeterminado)."""

    async def is_authenticated(self, page: Any) -> bool | None: ...


class UnmappedProbe:
    async def is_authenticated(self, page: Any) -> bool | None:
        return None


class ConsigSession:
    def __init__(self, profile_dir: Path, probe: SessionProbe | None = None, channel: str = "chrome") -> None:
        self._profile_dir = profile_dir
        self._probe: SessionProbe = probe or UnmappedProbe()
        self._channel = channel
        self._pw: Any = None
        self._context: Any = None
        self._missing_browser = False
        self.lock = asyncio.Lock()

    @property
    def page(self) -> Any:
        if self._context is None or not self._context.pages:
            raise SessionUnavailable("browser not open")
        return self._context.pages[0]

    async def open(self, start_url: str | None = None) -> SessionState:
        if self._context is not None:
            return await self.status()
        from playwright.async_api import Error as PwError
        from playwright.async_api import async_playwright

        self._profile_dir.mkdir(parents=True, exist_ok=True)
        self._pw = await async_playwright().start()
        try:
            self._context = await self._pw.chromium.launch_persistent_context(
                user_data_dir=str(self._profile_dir),
                channel=self._channel,
                headless=False,  # visível: o login é humano e a execução é acompanhável
                accept_downloads=False,
                args=["--disable-features=PasswordManagerOnboarding", "--no-default-browser-check"],
            )
        except PwError as e:
            await self._pw.stop()
            self._pw = None
            if "chrome" in str(e).lower() and ("not found" in str(e).lower() or "executable" in str(e).lower()):
                self._missing_browser = True
                logs.error("google chrome not found")
                raise BrowserMissing("Google Chrome não encontrado no computador") from e
            raise
        self._context.on("close", lambda *_: self._on_closed())
        if start_url:
            await self.page.goto(start_url)
        logs.info("consig session opened")
        return await self.status()

    def _on_closed(self) -> None:
        logs.warning("consig browser closed")
        self._context = None

    async def status(self) -> SessionState:
        if self._missing_browser:
            return SessionState.BROWSER_MISSING
        if self._context is None or not self._context.pages:
            return SessionState.CLOSED
        try:
            ok = await self._probe.is_authenticated(self.page)
        except Exception as e:  # noqa: BLE001 — a sonda nunca derruba o motor
            logs.warning("session probe failed", error=type(e).__name__)
            ok = None
        if ok is None:
            return SessionState.OPEN_UNVERIFIED
        return SessionState.AUTHENTICATED if ok else SessionState.EXPIRED

    async def close(self) -> None:
        if self._context is not None:
            await self._context.close()
            self._context = None
        if self._pw is not None:
            await self._pw.stop()
            self._pw = None
