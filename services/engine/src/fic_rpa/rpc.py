"""JSON-RPC 2.0 sobre stdio, uma mensagem por linha, nos dois sentidos.

- desktop → motor: requisições (id numérico) e respostas às chamadas do motor.
- motor → desktop: respostas, notificações (job.event) e chamadas "host.*" (id "h<n>").
"""

from __future__ import annotations

import asyncio
import itertools
import json
import sys
from collections.abc import Awaitable, Callable
from typing import Any, TextIO

from pydantic import ValidationError

from . import logs
from .errors import EngineError

Handler = Callable[[dict[str, Any]], Awaitable[Any]]

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
ENGINE_ERROR = -32000

MAX_LINE = 1_000_000


class RpcServer:
    def __init__(self, reader: asyncio.StreamReader, writer: TextIO = sys.stdout) -> None:
        self._reader = reader
        self._writer = writer
        self._handlers: dict[str, Handler] = {}
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._ids = itertools.count(1)
        self._tasks: set[asyncio.Task[None]] = set()
        self._write_lock = asyncio.Lock()

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    async def _send(self, msg: dict[str, Any]) -> None:
        async with self._write_lock:
            self._writer.write(json.dumps(msg, ensure_ascii=False, default=str) + "\n")
            self._writer.flush()

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def call_host(self, method: str, params: dict[str, Any], timeout: float = 30) -> Any:
        """Chama o desktop e aguarda a resposta. Timeout => exceção (o chamador decide o que fazer)."""
        call_id = f"h{next(self._ids)}"
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = fut
        try:
            await self._send({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params})
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(call_id, None)

    async def serve(self) -> None:
        while True:
            line = await self._reader.readline()
            if not line:
                logs.info("stdin closed; engine stopping")
                return
            if len(line) > MAX_LINE:
                await self._error(None, INVALID_REQUEST, "message too large")
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                await self._error(None, PARSE_ERROR, "invalid json")
                continue
            if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
                await self._error(None, INVALID_REQUEST, "invalid request")
                continue
            if "method" not in msg:
                self._resolve(msg)
                continue
            task = asyncio.create_task(self._dispatch(msg))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    def _resolve(self, msg: dict[str, Any]) -> None:
        fut = self._pending.get(str(msg.get("id")))
        if fut is None or fut.done():
            return
        if "error" in msg:
            fut.set_exception(EngineError(str(msg["error"].get("message", "host error"))))
        else:
            fut.set_result(msg.get("result"))

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        handler = self._handlers.get(method) if isinstance(method, str) else None
        if handler is None:
            if req_id is not None:
                await self._error(req_id, METHOD_NOT_FOUND, f"unknown method {method}")
            return
        if not isinstance(params, dict):
            await self._error(req_id, INVALID_PARAMS, "params must be an object")
            return
        try:
            result = await handler(params)
            if req_id is not None:
                await self._send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except ValidationError as e:
            fields = [".".join(str(p) for p in err["loc"]) for err in e.errors()]
            await self._error(req_id, INVALID_PARAMS, "invalid params", {"fields": fields})
        except EngineError as e:
            await self._error(req_id, ENGINE_ERROR, e.code, {"code": e.code, **e.data})
        except Exception as e:  # noqa: BLE001 — fronteira do processo: nunca derrubar o loop
            logs.error("handler crashed", method=method, error=type(e).__name__)
            await self._error(req_id, INTERNAL_ERROR, "internal error")

    async def _error(self, req_id: Any, code: int, message: str, data: dict[str, Any] | None = None) -> None:
        if req_id is None and code not in (PARSE_ERROR, INVALID_REQUEST):
            return
        err: dict[str, Any] = {"code": code, "message": message}
        if data:
            err["data"] = data
        await self._send({"jsonrpc": "2.0", "id": req_id, "error": err})
