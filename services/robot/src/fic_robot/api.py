"""Cliente mínimo do Supabase: Auth (senha + MFA TOTP + refresh) e RPC do PostgREST.

Só conexões de saída HTTPS. Erros de regra do banco chegam como P0001 com message = código estável.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx


class ApiError(Exception):
    def __init__(self, code: str, status: int = 0, detail: str | None = None, rule: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.detail = detail
        self.rule = rule  # recusa de regra do banco (P0001): não tem nada a ver com a sessão

    @property
    def is_auth_failure(self) -> bool:
        """Só 400/401/403 invalidam a sessão; 429/5xx/sem rede são temporários."""
        return self.status in (400, 401, 403) and not self.rule

    @property
    def is_transient(self) -> bool:
        return self.status == 0 or self.status == 429 or self.status >= 500


class Rpc(Protocol):
    def rpc(self, name: str, **params: Any) -> Any: ...


@dataclass
class Tokens:
    access_token: str
    refresh_token: str
    aal: str = "aal1"


class SupabaseApi:
    def __init__(self, url: str, publishable_key: str, client: httpx.Client | None = None) -> None:
        self.url = url.rstrip("/")
        self.key = publishable_key
        self.http = client or httpx.Client(timeout=20)
        self.tokens: Tokens | None = None

    # ------------------------------------------------------------------ http
    def _headers(self) -> dict[str, str]:
        h = {"apikey": self.key, "Content-Type": "application/json"}
        if self.tokens:
            h["Authorization"] = f"Bearer {self.tokens.access_token}"
        return h

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        try:
            res = self.http.post(f"{self.url}{path}", json=body, headers=self._headers())
        except httpx.HTTPError as exc:
            raise ApiError("NETWORK_ERROR", 0, type(exc).__name__) from exc
        if res.status_code >= 400:
            try:
                data = res.json()
            except ValueError:
                data = {}
            code = data.get("message") or data.get("error_code") or data.get("error") or f"HTTP_{res.status_code}"
            raise ApiError(str(code), res.status_code, data.get("details") or data.get("detail"),
                           rule=data.get("code") == "P0001")
        return res.json() if res.content else None

    # ------------------------------------------------------------------ auth
    def sign_in(self, email: str, password: str) -> Tokens:
        data = self._post("/auth/v1/token?grant_type=password", {"email": email, "password": password})
        self.tokens = Tokens(data["access_token"], data["refresh_token"])
        return self.tokens

    def verify_totp(self, code: str) -> Tokens:
        """Sobe a sessão para aal2 com o primeiro fator TOTP verificado do usuário."""
        try:
            res = self.http.get(f"{self.url}/auth/v1/user", headers=self._headers())
        except httpx.HTTPError as exc:
            raise ApiError("NETWORK_ERROR", 0) from exc
        factors = [f for f in res.json().get("factors", []) if f.get("status") == "verified"]
        if not factors:
            raise ApiError("MFA_NOT_ENROLLED", 403)
        fid = factors[0]["id"]
        challenge = self._post(f"/auth/v1/factors/{fid}/challenge", {})
        data = self._post(f"/auth/v1/factors/{fid}/verify", {"challenge_id": challenge["id"], "code": code})
        self.tokens = Tokens(data["access_token"], data["refresh_token"], "aal2")
        return self.tokens

    def refresh(self, refresh_token: str) -> Tokens:
        data = self._post("/auth/v1/token?grant_type=refresh_token", {"refresh_token": refresh_token})
        self.tokens = Tokens(data["access_token"], data["refresh_token"], "aal2")
        return self.tokens

    # ------------------------------------------------------------------ rpc
    def rpc(self, name: str, **params: Any) -> Any:
        return self._post(f"/rest/v1/rpc/{name}", {f"p_{k}": v for k, v in params.items()})
