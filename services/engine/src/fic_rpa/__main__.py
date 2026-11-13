"""Ponto de entrada do sidecar: fic-engine --data-dir <pasta> [--log-level INFO]."""

from __future__ import annotations

import argparse
import asyncio
import sys
import threading
from pathlib import Path

from . import logs
from .app import Engine
from .rpc import RpcServer


def _pump_stdin(loop: asyncio.AbstractEventLoop, reader: asyncio.StreamReader) -> None:
    # Thread dedicada: leitura assíncrona de stdin em pipe não é confiável no Windows.
    for line in sys.stdin.buffer:
        loop.call_soon_threadsafe(reader.feed_data, line)
    loop.call_soon_threadsafe(reader.feed_eof)


async def main(data_dir: Path) -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=2**21)
    threading.Thread(target=_pump_stdin, args=(loop, reader), daemon=True).start()
    rpc = RpcServer(reader, sys.stdout)
    engine = Engine(rpc, data_dir)
    serve = asyncio.create_task(rpc.serve())
    stop = asyncio.create_task(engine._stop.wait())
    await asyncio.wait({serve, stop}, return_when=asyncio.FIRST_COMPLETED)
    engine._stop.set()
    await engine.wait_stopped()


def run() -> None:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[attr-defined]
    parser = argparse.ArgumentParser(prog="fic-engine")
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args()
    logs.set_level(args.log_level)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    logs.info("engine starting")
    asyncio.run(main(args.data_dir))


if __name__ == "__main__":
    run()
