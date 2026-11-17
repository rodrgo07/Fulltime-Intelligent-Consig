from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from fic_robot.api import ApiError
from fic_robot.flows import fake_flow
from fic_robot.pending import PendingResult, PendingResults
from fic_robot.steps import Flow, Step, StepContext
from fic_robot.worker import RestartRequested, Worker

CPF = "529.982.247-25"
JOB = {"job_id": "j1", "request_id": "r1", "public_ref": "FIC-261117-ABCDEF12", "attempt": 1,
       "payload": {"documento": CPF}, "fields": []}


class FakeApi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.commands: list[dict[str, Any]] = []
        self.job: dict[str, Any] | None = None
        self.fail_on: dict[str, ApiError] = {}

    def rpc(self, name: str, **params: Any) -> Any:
        self.calls.append((name, params))
        if name in self.fail_on:
            raise self.fail_on[name]
        if name == "robot_poll_commands":
            out, self.commands = self.commands, []
            return out
        if name == "claim_next_job":
            job, self.job = self.job, None
            return dict(job, payload=dict(job["payload"])) if job else None
        if name == "robot_report_state":
            return {"paused": params["paused"], "ai_enabled": False, "ai_model": None}
        return None

    def names(self) -> list[str]:
        return [n for n, _ in self.calls if n not in ("robot_poll_commands", "robot_report_state")]


class FakeBrowser:
    driver = None

    def __init__(self, state: str = "authenticated") -> None:
        self.state = state
        self.opened = 0

    def session_state(self) -> str:
        return self.state

    def open_consig(self) -> None:
        self.opened += 1


class Boom(Step):
    name = "boom"

    def __init__(self, side_effect: bool = False) -> None:
        self.side_effect = side_effect  # type: ignore[misc]

    def run(self, driver: Any, ctx: StepContext) -> None:
        raise RuntimeError(f"elemento não encontrado para o cliente {ctx.payload['documento']} joao@ex.com")


@pytest.fixture
def api() -> FakeApi:
    return FakeApi()


def make(api: FakeApi, tmp_path: Path, flow: Flow | None = None, browser: FakeBrowser | None = None) -> Worker:
    return Worker(api, browser or FakeBrowser(), flow if flow is not None else fake_flow(),
                  PendingResults(tmp_path / "pending-results.json"), "pc-teste", "2.0.0")


def test_happy_path_marks_side_effect_before_submit_and_completes(api: FakeApi, tmp_path: Path) -> None:
    api.job = JOB
    w = make(api, tmp_path)
    assert w.tick() == "completed"
    names = api.names()
    assert names.index("mark_side_effect_started") < names.index("report_captured_result") < names.index("complete_job")
    complete = dict(api.calls)["complete_job"]
    assert complete["adhesion_number"] == "FALSO-ABCDEF12"
    assert not w.pending


def test_error_before_side_effect_fails_retryable_and_redacted(api: FakeApi, tmp_path: Path) -> None:
    api.job = JOB
    w = make(api, tmp_path, Flow("t", 1, [Boom()]))
    assert w.tick() == "failed"
    fail = dict(api.calls)["fail_job"]
    assert fail["retryable"] is True
    assert "529" not in fail["error_message"] and "joao@ex.com" not in fail["error_message"]
    assert "[REDACTED]" in fail["error_message"]
    assert "escalate_job" not in api.names()


def test_error_after_side_effect_escalates_never_retries(api: FakeApi, tmp_path: Path) -> None:
    api.job = JOB
    w = make(api, tmp_path, Flow("t", 1, [Boom(side_effect=True)]))
    assert w.tick() == "escalated"
    assert "fail_job" not in api.names()
    assert "529" not in dict(api.calls)["escalate_job"]["message"]


def test_no_claim_while_pending(api: FakeApi, tmp_path: Path) -> None:
    w = make(api, tmp_path)
    w.pending.add(PendingResult("j0", "r0", "ADE-1"))
    api.fail_on["complete_job"] = ApiError("NETWORK_ERROR", 0)
    assert w.tick() == "pending"
    assert "claim_next_job" not in api.names()
    assert w.pending  # continua guardado


def test_pending_is_sent_and_removed_when_network_returns(api: FakeApi, tmp_path: Path) -> None:
    w = make(api, tmp_path)
    w.pending.add(PendingResult("j0", "r0", "ADE-1"))
    assert w.tick() == "idle"
    assert ("complete_job", {"job_id": "j0", "adhesion_number": "ADE-1", "external_operation_id": None,
                             "result_status": "GERADA"}) in api.calls
    assert not w.pending


def test_result_survives_crash_between_capture_and_complete(api: FakeApi, tmp_path: Path) -> None:
    api.job = JOB
    api.fail_on["complete_job"] = ApiError("HTTP_503", 503)
    w = make(api, tmp_path)
    w.tick()
    restarted = make(FakeApi(), tmp_path)  # processo novo, mesma pasta
    assert [p.adhesion_number for p in restarted.pending.load()] == ["FALSO-ABCDEF12"]


@pytest.mark.parametrize("state", ["logged_out", "unknown"])
def test_no_claim_without_consig_session(api: FakeApi, tmp_path: Path, state: str) -> None:
    assert make(api, tmp_path, browser=FakeBrowser(state)).tick() == "no_session"
    assert "claim_next_job" not in api.names()


def test_no_claim_without_flow(api: FakeApi, tmp_path: Path) -> None:
    w = Worker(api, FakeBrowser(), None, PendingResults(tmp_path / "p.json"), "pc", "2.0.0")
    assert w.tick() == "no_flow"
    assert "claim_next_job" not in api.names()
    assert dict(api.calls)["robot_report_state"]["flow_ready"] is False


def test_pause_resume_and_open_consig_commands(api: FakeApi, tmp_path: Path) -> None:
    browser = FakeBrowser()
    w = make(api, tmp_path, browser=browser)
    api.commands = [{"id": 1, "kind": "pause"}, {"id": 2, "kind": "open_consig"}]
    assert w.tick() == "paused"
    assert browser.opened == 1
    api.commands = [{"id": 3, "kind": "resume"}]
    assert w.tick() == "idle"


def test_restart_command_raises(api: FakeApi, tmp_path: Path) -> None:
    api.commands = [{"id": 1, "kind": "restart"}]
    with pytest.raises(RestartRequested):
        make(api, tmp_path).tick()


def test_payload_cleared_after_job(api: FakeApi, tmp_path: Path) -> None:
    seen: list[dict[str, Any]] = []

    class Spy(Step):
        name = "spy"
        side_effect = True

        def run(self, driver: Any, ctx: StepContext) -> Any:
            seen.append(ctx.payload)
            from fic_robot.steps import ProposalResult
            return ProposalResult("ADE-9")

    api.job = JOB
    make(api, tmp_path, Flow("t", 1, [Spy()])).tick()
    assert seen == [{}]


def test_definitive_rejection_does_not_block_queue_forever(api: FakeApi, tmp_path: Path) -> None:
    w = make(api, tmp_path)
    w.pending.add(PendingResult("j0", "r0", "ADE-1"))
    api.fail_on["complete_job"] = ApiError("JOB_NOT_ACTIVE", 400, rule=True)
    assert w.tick() == "idle"
    assert not w.pending
