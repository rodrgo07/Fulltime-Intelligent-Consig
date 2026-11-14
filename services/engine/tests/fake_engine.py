"""Motor de TESTE com fluxo FALSO — usado só pelos testes ponta a ponta da fila (D2).

NÃO representa o Consig: nenhuma tela, seletor, campo ou URL do Banco BMG. Fica em tests/ (fora do pacote
e do sidecar) e o fluxo é passado direto ao Engine, nunca registrado em PRODUCTION_WORKFLOWS.
Só roda com FIC_FAKE_ENGINE_FOR_TESTS=1.

Uso: python tests/fake_engine.py --data-dir <pasta> --scenario <nome>
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import threading
from pathlib import Path

from fic_rpa import logs
from fic_rpa.app import Engine
from fic_rpa.errors import StepTimeout
from fic_rpa.rpc import RpcServer
from fic_rpa.workflow import ProposalResult, Step, StepContext, Workflow
from fic_rpa.workflows import ACTIVE_WORKFLOW_ID, PRODUCTION_WORKFLOWS

FAKE_WORKFLOW_ID = "fluxo_falso_de_teste"
FAKE_ADHESION = "ADE-FALSO-0001"


class Preparar(Step):
    name = "falso_preparar"
    timeout_s = 7200  # type: ignore[misc]

    def __init__(self, fail_attempts: set[int] | None = None, hang: bool = False) -> None:
        self.fail_attempts = fail_attempts or set()
        self.hang = hang

    async def run(self, ctx: StepContext) -> None:
        ctx.require("documento")  # usa o payload de verdade, como o fluxo real faria
        if self.hang:
            await asyncio.sleep(3600)
        if ctx.attempt in self.fail_attempts:
            raise StepTimeout("falha simulada antes do ponto sem retorno", step=self.name)


class Enviar(Step):
    name = "falso_enviar"
    side_effect = True

    async def run(self, ctx: StepContext) -> None:
        ctx.state["enviado"] = True


class Quebra(Step):
    name = "falso_quebra"

    async def run(self, ctx: StepContext) -> None:
        raise RuntimeError("falha simulada depois do ponto sem retorno")


class Trava(Step):
    name = "falso_trava"
    timeout_s = 7200  # type: ignore[misc]

    async def run(self, ctx: StepContext) -> None:
        await asyncio.sleep(3600)


class Resultado(Step):
    name = "falso_resultado"

    async def run(self, ctx: StepContext) -> ProposalResult:
        assert ctx.state.get("enviado")
        return ProposalResult(adhesion_number=FAKE_ADHESION, result_status="GERADA", external_operation_id="OP-FALSO-1")


SCENARIOS = {
    "ok": lambda: [Preparar(), Enviar(), Resultado()],
    "fail_first_attempt": lambda: [Preparar(fail_attempts={1}), Enviar(), Resultado()],
    "fail_before": lambda: [Preparar(fail_attempts={1, 2, 3, 4, 5}), Enviar(), Resultado()],
    "fail_after": lambda: [Preparar(), Enviar(), Quebra(), Resultado()],
    "hang_before": lambda: [Preparar(hang=True), Enviar(), Resultado()],
    "hang_after": lambda: [Preparar(), Enviar(), Trava(), Resultado()],
}


def build(scenario: str) -> Workflow:
    return Workflow(id=FAKE_WORKFLOW_ID, version=1, steps=SCENARIOS[scenario](), needs_session=False)


def _pump_stdin(loop: asyncio.AbstractEventLoop, reader: asyncio.StreamReader) -> None:
    for line in sys.stdin.buffer:
        loop.call_soon_threadsafe(reader.feed_data, line)
    loop.call_soon_threadsafe(reader.feed_eof)


async def main(data_dir: Path, scenario: str) -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=2**21)
    threading.Thread(target=_pump_stdin, args=(loop, reader), daemon=True).start()
    rpc = RpcServer(reader, sys.stdout)
    engine = Engine(rpc, data_dir, workflows={ACTIVE_WORKFLOW_ID: lambda: build(scenario)})
    serve = asyncio.create_task(rpc.serve())
    stop = asyncio.create_task(engine._stop.wait())
    await asyncio.wait({serve, stop}, return_when=asyncio.FIRST_COMPLETED)
    engine._stop.set()
    await engine.wait_stopped()


def run() -> None:
    if os.environ.get("FIC_FAKE_ENGINE_FOR_TESTS") != "1":
        sys.exit("fake_engine é só para testes (defina FIC_FAKE_ENGINE_FOR_TESTS=1)")
    assert FAKE_WORKFLOW_ID not in PRODUCTION_WORKFLOWS and not PRODUCTION_WORKFLOWS
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[attr-defined]
    parser = argparse.ArgumentParser(prog="fake-engine")
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--scenario", required=True, choices=sorted(SCENARIOS))
    args = parser.parse_args()
    logs.set_level("DEBUG")
    args.data_dir.mkdir(parents=True, exist_ok=True)
    asyncio.run(main(args.data_dir, args.scenario))


if __name__ == "__main__":
    run()
