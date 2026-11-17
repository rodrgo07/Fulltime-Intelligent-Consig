from __future__ import annotations

import pytest

from fic_robot.api import ApiError, Tokens
from fic_robot.auth import MAX_AGE_S, KeyringStore, SessionManager


class MemKeyring:
    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str] = {}

    def set_password(self, s: str, a: str, v: str) -> None:
        self.data[(s, a)] = v

    def get_password(self, s: str, a: str) -> str | None:
        return self.data.get((s, a))

    def delete_password(self, s: str, a: str) -> None:
        self.data.pop((s, a), None)


class FakeApi:
    def __init__(self, error: ApiError | None = None) -> None:
        self.error = error

    def refresh(self, token: str) -> Tokens:
        if self.error:
            raise self.error
        return Tokens("access", token + "+", "aal2")


def store(now: list[float]) -> KeyringStore:
    return KeyringStore(MemKeyring(), clock=lambda: now[0])


def test_transient_error_keeps_session() -> None:
    now = [1000.0]
    s = store(now)
    s.save("rt")
    mgr = SessionManager(FakeApi(ApiError("HTTP_503", 503)), s)  # type: ignore[arg-type]
    with pytest.raises(ApiError):
        mgr.resume()
    assert s.load() == "rt"


@pytest.mark.parametrize("status", [400, 401, 403])
def test_auth_failure_clears_session(status: int) -> None:
    s = store([1000.0])
    s.save("rt")
    assert SessionManager(FakeApi(ApiError("invalid_grant", status)), s).resume() is False  # type: ignore[arg-type]
    assert s.load() is None


def test_session_expires_after_24h_even_if_refreshed() -> None:
    now = [1000.0]
    s = store(now)
    s.save("rt")
    mgr = SessionManager(FakeApi(), s)  # type: ignore[arg-type]
    now[0] += MAX_AGE_S - 10
    assert mgr.resume() is True  # renovou, mas o início da sessão não muda
    now[0] += 20
    assert s.load() is None
