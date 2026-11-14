from __future__ import annotations

import json

import pytest

from fic_rpa import logs


def test_logs_redact_personal_data(capsys: pytest.CaptureFixture[str]) -> None:
    logs.info("cliente 529.982.247-25 email a@b.com conta 123456789", payload={"cpf": "1"}, job_id="j1")
    rec = json.loads(capsys.readouterr().err.strip())
    assert "529" not in rec["msg"] and "a@b.com" not in rec["msg"] and "123456789" not in rec["msg"]
    assert rec["payload"] == "[OMITTED]"
    assert rec["job_id"] == "j1"


def test_debug_hidden_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    logs.set_level("INFO")
    logs.debug("x")
    assert capsys.readouterr().err == ""
