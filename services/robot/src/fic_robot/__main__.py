"""Ponto de entrada: `python -m fic_robot` (o iniciar.bat faz isso).

Configuração por variáveis de ambiente ou pelo arquivo `robo.env` na pasta do robô (fora do git):
  FIC_SUPABASE_URL, FIC_SUPABASE_KEY (chave publicável), FIC_CONSIG_URL (padrão: login do BMG Consig),
  FIC_FAKE_FLOW=1 (só teste), FIC_POLL_SECONDS (padrão 3).
"""

from __future__ import annotations

import os
import platform
import sys
import time
from pathlib import Path

from . import __version__, consig
from . import redact as log
from .api import ApiError, SupabaseApi
from .auth import KeyringStore, SessionManager
from .browser import ChromeBrowser, NoBrowser
from .flows import select_flow
from .pending import PendingResults
from .worker import RestartRequested, Worker

HOME = Path(os.environ.get("FIC_ROBOT_HOME", Path.cwd()))
EXIT_RESTART = 3


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def chrome_browser() -> ChromeBrowser:
    return ChromeBrowser(HOME / "chrome-profile", os.environ.get("FIC_CONSIG_URL") or consig.LOGIN_URL,
                         consig.session_probe)


def main() -> int:
    load_env_file(HOME / "robo.env")
    url, key = os.environ.get("FIC_SUPABASE_URL"), os.environ.get("FIC_SUPABASE_KEY")
    if not url or not key:
        print("Configure FIC_SUPABASE_URL e FIC_SUPABASE_KEY em robo.env (veja robo.env.example).")
        return 2

    api = SupabaseApi(url, key)
    session = SessionManager(api, KeyringStore())
    while True:
        try:
            session.ensure()
            break
        except ApiError as exc:
            if not exc.is_transient:
                print(f"Login recusado ({exc.code}). Tente de novo.")
                continue
            log.warning("sem conexão com o Supabase; nova tentativa em 10 s", code=exc.code)
            time.sleep(10)

    flow = select_flow()
    browser = NoBrowser() if os.environ.get("FIC_FAKE_FLOW") == "1" else chrome_browser()
    worker = Worker(api, browser, flow, PendingResults(HOME / "pending-results.json"),
                    worker_id=f"{platform.node()}-robot"[:100], version=__version__)
    poll = float(os.environ.get("FIC_POLL_SECONDS", "3"))
    log.info("robô iniciado", version=__version__, flow=flow.id if flow else "nenhum")

    try:
        while True:
            try:
                outcome = worker.tick()
                if outcome not in ("idle", "paused", "no_flow", "no_session"):
                    log.info("volta da fila", outcome=outcome)
            except ApiError as exc:
                if exc.status == 401:
                    try:
                        if not session.resume():
                            session.login_interactive()
                    except ApiError as again:
                        log.warning("renovação da sessão falhou", code=again.code)
                elif exc.is_transient:
                    log.warning("Supabase indisponível; mantendo a sessão", code=exc.code)
                else:
                    log.error("erro da API", code=exc.code)
            time.sleep(poll)
    except RestartRequested:
        log.info("reinício pedido pelo painel")
        return EXIT_RESTART
    except KeyboardInterrupt:
        return 0
    finally:
        browser.quit()


if __name__ == "__main__":
    sys.exit(main())
