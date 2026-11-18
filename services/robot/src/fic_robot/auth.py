"""Sessão do robô no Supabase.

Primeira vez: e-mail, senha e código MFA pedidos no terminal (a senha não é guardada).
Depois: refresh token no Gerenciador de Credenciais do Windows (keyring), válido por no máximo 24 h.
Erro temporário (429/5xx/sem rede) NÃO apaga a sessão; só 400/401/403 da renovação apagam.
"""

from __future__ import annotations

import getpass
import json
import time
from collections.abc import Callable
from typing import Any

from .api import ApiError, SupabaseApi

SERVICE = "fic-robot"
ACCOUNT = "supabase-session"
MAX_AGE_S = 24 * 3600


class KeyringStore:
    def __init__(self, backend: Any = None, clock: Callable[[], float] = time.time) -> None:
        if backend is None:
            import keyring as backend  # noqa: PLC0415
        self.kr = backend
        self.clock = clock

    def save(self, refresh_token: str, started_at: float | None = None) -> None:
        current = self._read()
        started = started_at or (current or {}).get("started_at") or self.clock()
        self.kr.set_password(SERVICE, ACCOUNT, json.dumps({"refresh_token": refresh_token, "started_at": started}))

    def _read(self) -> dict[str, Any] | None:
        raw = self.kr.get_password(SERVICE, ACCOUNT)
        return json.loads(raw) if raw else None

    def load(self) -> str | None:
        data = self._read()
        if not data:
            return None
        if self.clock() - float(data["started_at"]) > MAX_AGE_S:
            self.clear()
            return None
        return str(data["refresh_token"])

    def clear(self) -> None:
        try:
            self.kr.delete_password(SERVICE, ACCOUNT)
        except Exception:  # noqa: BLE001 — já não existe
            pass


class SessionManager:
    def __init__(self, api: SupabaseApi, store: KeyringStore,
                 ask: Callable[[str], str] = input, ask_secret: Callable[[str], str] = getpass.getpass) -> None:
        self.api = api
        self.store = store
        self.ask = ask
        self.ask_secret = ask_secret

    def resume(self) -> bool:
        """Renova a sessão guardada. False quando não há sessão válida (precisa de login)."""
        token = self.store.load()
        if not token:
            return False
        try:
            tokens = self.api.refresh(token)
        except ApiError as exc:
            if exc.is_auth_failure:
                self.store.clear()
                return False
            raise  # temporário: mantém a sessão e o chamador tenta de novo
        self.store.save(tokens.refresh_token)
        return True

    def login_interactive(self) -> None:
        print("Login do robô (usuário backoffice). A senha não é guardada.")
        email = self.ask("E-mail: ").strip()
        password = self.ask_secret("Senha: ")
        self.api.sign_in(email, password)
        code = self.ask("Código do autenticador (6 dígitos): ").strip()
        tokens = self.api.verify_totp(code)
        self.store.clear()
        self.store.save(tokens.refresh_token)

    def ensure(self) -> None:
        if not self.resume():
            self.login_interactive()
