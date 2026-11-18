from __future__ import annotations

import json

import httpx
import pytest

from fic_robot.api import ApiError, SupabaseApi
from fic_robot.redact import redact


@pytest.mark.parametrize("text", ["52998224725", "529.982.247-25", "fulano@empresa.com.br", "conta 123456789"])
def test_redact_hides_personal_data(text: str) -> None:
    out = redact(f"erro com {text} aqui")
    assert text.split()[-1] not in out
    assert "[REDACTED]" in out


def test_redact_keeps_technical_ids() -> None:
    assert redact("job FIC-261117-ABCDEF12 etapa 3") == "job FIC-261117-ABCDEF12 etapa 3"


def _api(handler) -> SupabaseApi:  # type: ignore[no-untyped-def]
    return SupabaseApi("https://exemplo.invalid", "sb_publishable_teste", httpx.Client(transport=httpx.MockTransport(handler)))


def test_rpc_prefixes_params_and_maps_p0001_code() -> None:
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"] = req.url.path
        seen["body"] = json.loads(req.content)
        return httpx.Response(400, json={"code": "P0001", "message": "JOB_NOT_ACTIVE", "details": "failed"})

    with pytest.raises(ApiError) as err:
        _api(handler).rpc("complete_job", job_id="j1", adhesion_number="A")
    assert seen == {"path": "/rest/v1/rpc/complete_job", "body": {"p_job_id": "j1", "p_adhesion_number": "A"}}
    assert err.value.code == "JOB_NOT_ACTIVE" and err.value.detail == "failed"
    assert err.value.rule and not err.value.is_auth_failure  # recusa de regra não derruba a sessão


@pytest.mark.parametrize(("status", "transient", "auth"), [(503, True, False), (429, True, False), (401, False, True)])
def test_error_classes(status: int, transient: bool, auth: bool) -> None:
    e = ApiError("X", status)
    assert (e.is_transient, e.is_auth_failure) == (transient, auth)


def test_network_error_is_transient() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sem rede")

    with pytest.raises(ApiError) as err:
        _api(handler).rpc("robot_poll_commands")
    assert err.value.is_transient and not err.value.is_auth_failure
