from __future__ import annotations

import asyncio

import pytest
from conftest import (
    BoomStep, FakeAdvisor, FlakyScreenStep, OkStep, Recorder, ResultStep, SideEffectStep, SlowStep, params, wf,
)

from fic_rpa.errors import EngineError
from fic_rpa.executor import JobExecutor
from fic_rpa.workflow import Recovery


async def run(rec: Recorder, workflow, advisor=None, p=None) -> JobExecutor:
    ex = JobExecutor(rec.emit, rec.confirm_side_effect, advisor=advisor, heartbeat_s=10, wait_and_retry_s=0)
    ex.start(p or params(), workflow, None)
    await ex.wait()
    return ex


async def test_success_emits_steps_and_result(rec: Recorder) -> None:
    await run(rec, wf(OkStep(), SideEffectStep(), ResultStep()))
    assert [e.step for e in rec.events if e.type == "step_started"] == ["preparar", "efeito", "resultado"]
    last = rec.last()
    assert last.type == "completed"
    assert last.data["adhesion_number"] == "ADE-FAKE-1"
    assert rec.confirm_calls == [("job-1", "efeito")]


async def test_side_effect_not_run_without_host_confirmation() -> None:
    rec = Recorder(confirm=False)
    step = SideEffectStep()
    await run(rec, wf(OkStep(), step, ResultStep()))
    assert rec.last().type == "failed"
    assert rec.last().data["error_code"] == "HOST_REJECTED_SIDE_EFFECT"
    assert all(e.step != "resultado" for e in rec.events)


async def test_failure_before_side_effect_is_retryable_failure(rec: Recorder) -> None:
    await run(rec, wf(SlowStep(), ResultStep()))
    assert rec.last().type == "failed"
    assert rec.last().data == {"error_code": "STEP_TIMEOUT", "message": "step lenta timed out", "retryable": True}


async def test_any_failure_after_side_effect_escalates(rec: Recorder) -> None:
    await run(rec, wf(SideEffectStep(), BoomStep()))
    assert rec.last().type == "escalated"
    assert rec.last().data["reason_code"] == "STEP_CRASHED"


async def test_crash_before_side_effect_is_failed(rec: Recorder) -> None:
    await run(rec, wf(BoomStep()))
    assert rec.last().type == "failed"
    assert rec.last().data["error_code"] == "STEP_CRASHED"


async def test_unexpected_screen_without_ai_goes_to_human(rec: Recorder) -> None:
    await run(rec, wf(FlakyScreenStep(), ResultStep()))
    assert rec.last().type == "escalated"
    assert rec.last().data["reason_code"] == "UNEXPECTED_SCREEN"


async def test_ai_retry_suggestion_is_applied_by_deterministic_code(rec: Recorder) -> None:
    step = FlakyScreenStep(failures=1)
    advisor = FakeAdvisor(Recovery.RETRY_STEP)
    await run(rec, wf(step, ResultStep()), advisor)
    assert rec.last().type == "completed"
    assert step.calls == 2 and advisor.calls == 1


async def test_ai_never_retries_a_side_effect_step(rec: Recorder) -> None:
    step = FlakyScreenStep(failures=1, side_effect=True)
    await run(rec, wf(step, ResultStep()), FakeAdvisor(Recovery.RETRY_STEP))
    assert rec.last().type == "escalated"
    assert step.calls == 1


@pytest.mark.parametrize("advice", [
    FakeAdvisor(Recovery.RETRY_STEP, confidence=0.5),   # confiança baixa
    FakeAdvisor("delete_everything"),                    # ação fora da lista
    FakeAdvisor(None),                                   # IA indisponível
])
async def test_untrusted_ai_advice_escalates(rec: Recorder, advice: FakeAdvisor) -> None:
    await run(rec, wf(FlakyScreenStep(), ResultStep()), advice)
    assert rec.last().type == "escalated"


async def test_ai_recoveries_are_bounded(rec: Recorder) -> None:
    step = FlakyScreenStep(failures=10)
    await run(rec, wf(step, ResultStep()), FakeAdvisor(Recovery.WAIT_AND_RETRY))
    assert rec.last().type == "escalated"
    assert step.calls == JobExecutor.MAX_AI_RECOVERIES + 1


async def test_workflow_without_result_needs_human(rec: Recorder) -> None:
    await run(rec, wf(OkStep()))
    assert rec.last().type == "escalated"
    assert rec.last().data["reason_code"] == "NO_RESULT"


async def test_cancel_before_side_effect(rec: Recorder) -> None:
    ex = JobExecutor(rec.emit, rec.confirm_side_effect, heartbeat_s=10)
    slow = SlowStep()
    slow.timeout_s = 5  # type: ignore[misc]
    ex.start(params(), wf(slow), None)
    await asyncio.sleep(0.05)
    assert await ex.cancel("job-1") is True
    assert rec.last().type == "failed"
    assert rec.last().data["error_code"] == "JOB_CANCELLED"
    assert ex.current_job is None


async def test_only_one_job_at_a_time(rec: Recorder) -> None:
    ex = JobExecutor(rec.emit, rec.confirm_side_effect, heartbeat_s=10)
    slow = SlowStep()
    slow.timeout_s = 5  # type: ignore[misc]
    ex.start(params(), wf(slow), None)
    with pytest.raises(EngineError):
        ex.start(params("job-2"), wf(OkStep()), None)
    await ex.cancel("job-1")


async def test_job_deadline(rec: Recorder) -> None:
    slow = SlowStep()
    slow.timeout_s = 5  # type: ignore[misc]
    await run(rec, wf(slow), p=params(deadline=0.05))
    assert rec.last().data["error_code"] == "STEP_TIMEOUT"


async def test_heartbeat_emitted(rec: Recorder) -> None:
    ex = JobExecutor(rec.emit, rec.confirm_side_effect, heartbeat_s=0.01)
    slow = SlowStep()
    slow.timeout_s = 0.1  # type: ignore[misc]
    ex.start(params(), wf(slow), None)
    await ex.wait()
    assert any(e.type == "heartbeat" for e in rec.events)
