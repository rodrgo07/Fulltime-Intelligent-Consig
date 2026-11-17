"""Chrome instalado, controlado pelo Selenium, com perfil dedicado na pasta do robô.

A pessoa faz o login no Consig nessa janela; o robô nunca vê nem guarda a senha.
O chromedriver é baixado pelo Selenium Manager para a pasta do usuário (sem administrador).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import redact as log

SessionProbe = Callable[[Any], bool]


class ChromeBrowser:
    def __init__(self, profile_dir: Path, consig_url: str | None, probe: SessionProbe | None = None) -> None:
        self.profile_dir = profile_dir
        self.consig_url = consig_url
        self.probe = probe  # parte do mapeamento do Consig; sem ela o estado é 'unknown'
        self._driver: Any = None

    @property
    def driver(self) -> Any:
        if self._driver is None or not self._alive():
            self._driver = self._start()
        return self._driver

    def _alive(self) -> bool:
        try:
            _ = self._driver.window_handles
            return True
        except Exception:  # noqa: BLE001 — janela fechada pela pessoa
            return False

    def _start(self) -> Any:
        from selenium import webdriver  # noqa: PLC0415 — import pesado só quando precisa

        self.profile_dir.mkdir(parents=True, exist_ok=True)
        opts = webdriver.ChromeOptions()
        opts.add_argument(f"--user-data-dir={self.profile_dir}")
        opts.add_argument("--no-first-run")
        opts.add_argument("--no-default-browser-check")
        opts.add_experimental_option("excludeSwitches", ["enable-automation"])
        log.info("abrindo Chrome com perfil dedicado")
        return webdriver.Chrome(options=opts)

    def open_consig(self) -> None:
        if not self.consig_url:
            log.warning("endereço do Consig não configurado (FIC_CONSIG_URL)")
            return
        self.driver.get(self.consig_url)

    def session_state(self) -> str:
        if self.probe is None or self._driver is None:
            return "unknown"
        try:
            return "authenticated" if self.probe(self._driver) else "logged_out"
        except Exception as exc:  # noqa: BLE001
            log.warning("sonda de sessão falhou", err=log.safe_message(exc))
            return "unknown"

    def quit(self) -> None:
        if self._driver is not None:
            try:
                self._driver.quit()
            finally:
                self._driver = None


class NoBrowser:
    """Usado com o fluxo falso: não abre Chrome e diz que a sessão está ativa."""

    driver = None

    def session_state(self) -> str:
        return "authenticated" if os.environ.get("FIC_FAKE_FLOW") == "1" else "unknown"

    def open_consig(self) -> None:
        log.info("open_consig ignorado: fluxo falso sem navegador")

    def quit(self) -> None:
        pass
