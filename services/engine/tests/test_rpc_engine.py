from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeRuntime, OkStep, ResultStep, SideEffectStep, wf

from fic_ai.manifest import load_manifest
from fic_ai.service import AiService
from fic_rpa.app import Engine
from fic_rpa.rpc import RpcServer

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures" / "engine-rpc"


class Harness:
    def __init__(self, tmp: Path, workflows: dict[str, Any] | None = None) -> None:
        self.reader = asyncio.StreamReader()
        self.out = io.StringIO()
        self.rpc = RpcServer(self.reader, self.out)
        self.engine = Engine(self.rpc, tmp, workflows=workflows or {},
                             ai=AiService(tmp / "ialocal", load_manifest(), runtime=FakeRuntime()))
        self.task = asyncio.create_task(self.rpc.serve())
        self._seen = 0

    def send(self, msg: dict[str, Any]) -> None:
        self.reader.feed_data((json.dumps(msg) + "\n").encode())

    async def next_msg(self, pred=lambda m: True, timeout: float = 2) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end:
            lines = self.out.getvalue().splitlines()
            while self._seen < len(lines):
                m = json.loads(lines[self._seen])
                self._seen += 1
                if pred(m):
                    return m
            await asyncio.sleep(0.01)
        raise AssertionError("no message")

    async def call(self, method: str, params: dict[str, Any] | None = None, id_: int = 1) -> dict[str, Any]:
        self.send({"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}})
        return await self.next_msg(lambda m: m.get("id") == id_)

    async def close(self) -> None:
        self.reader.feed_eof()
        await self.task


@pytest.fixture
async def h(tmp_path: Path):
    harness = Harness(tmp_path)
    yield harness
    await harness.close()


async def test_hello_and_capabilities(h: Harness) -> None:
    r = await h.call("engine.hello", {"contract_version": 1})
    assert r["result"]["capabilities"]["workflow_ready"] is False


async def test_contract_mismatch(h: Harness) -> None:
    r = await h.call("engine.hello", {"contract_version": 99})
    assert r["error"]["data"]["code"] == "CONTRACT_MISMATCH"


async def test_job_rejected_while_consig_workflow_not_mapped(h: Harness) -> None:
    params = json.loads((FIXTURES / "job.execute.params.json").read_text())
    r = await h.call("job.execute", params)
    assert r["error"]["data"]["code"] == "WORKFLOW_NOT_READY"


async def test_invalid_params_and_unknown_method(h: Harness) -> None:
    r = await h.call("job.execute", {"job_id": "x", "payload": "não é objeto"})
    assert r["error"]["code"] == -32602
    assert "payload" in r["error"]["data"]["fields"]
    r = await h.call("system.exec", {"cmd": "calc.exe"}, id_=2)
    assert r["error"]["code"] == -32601


async def test_invalid_json_line(h: Harness) -> None:
    h.reader.feed_data(b"{nao json\n")
    m = await h.next_msg(lambda m: "error" in m)
    assert m["error"]["code"] == -32700


async def test_ai_model_must_come_from_manifest(h: Harness) -> None:
    r = await h.call("ai.configure", {"enabled": True, "model": "modelo-qualquer:70b"})
    assert r["error"]["data"]["code"] == "MODEL_NOT_IN_MANIFEST"
    ok = await h.call("ai.configure", json.loads((FIXTURES / "ai.configure.params.json").read_text()), id_=2)
    assert ok["result"]["enabled"] is True
    assert ok["result"]["state"] == "runtime_missing"


async def test_full_job_over_rpc_with_side_effect_confirmation(tmp_path: Path) -> None:
    h = Harness(tmp_path, workflows={"consig_proposal": lambda: wf(OkStep(), SideEffectStep(), ResultStep())})
    params = json.loads((FIXTURES / "job.execute.params.json").read_text())
    r = await h.call("job.execute", params)
    assert r["result"]["accepted"] is True
    confirm = await h.next_msg(lambda m: m.get("method") == "host.confirm_side_effect")
    assert confirm["params"] == {"job_id": params["job_id"], "step": "efeito"}
    h.send({"jsonrpc": "2.0", "id": confirm["id"], "result": {"confirmed": True}})
    done = await h.next_msg(lambda m: m.get("method") == "job.event" and m["params"]["type"] == "completed")
    assert done["params"]["data"]["adhesion_number"] == "ADE-FAKE-1"
    # O payload nunca volta pelo canal de eventos.
    assert "52998224725" not in h.out.getvalue().split(confirm["id"])[1]
    await h.close()


def test_fixtures_match_protocol_models() -> None:
    from fic_rpa.protocol import AiConfigureParams, JobEvent, JobExecuteParams, SideEffectConfirm

    JobExecuteParams.model_validate_json((FIXTURES / "job.execute.params.json").read_text())
    AiConfigureParams.model_validate_json((FIXTURES / "ai.configure.params.json").read_text())
    SideEffectConfirm.model_validate_json((FIXTURES / "host.confirm_side_effect.params.json").read_text())
    for name in ("completed", "failed", "escalated"):
        JobEvent.model_validate_json((FIXTURES / f"job.event.{name}.json").read_text())
