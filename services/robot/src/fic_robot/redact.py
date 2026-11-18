"""Redação de dados pessoais e log estruturado.

Tudo que sai do processo (terminal, arquivo de log, error_message no banco) passa por `redact`.
Logs carregam só identificadores técnicos (job_id, request_id, etapa), nunca o payload.
"""

from __future__ import annotations

import json
import re
import sys
import time
from typing import Any

_CPF = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_LONG_DIGITS = re.compile(r"\b\d{8,}\b")  # contas, documentos, telefones
_FORBIDDEN_KEYS = {"payload", "password", "senha", "token", "refresh_token", "access_token", "cpf",
                   "documento", "document", "screenshot"}
MASK = "[REDACTED]"


def redact(text: str) -> str:
    text = _CPF.sub(MASK, text)
    text = _EMAIL.sub(MASK, text)
    return _LONG_DIGITS.sub(MASK, text)


def safe_message(exc: BaseException, limit: int = 1000) -> str:
    """Mensagem de erro pronta para sair do processo (banco, painel)."""
    return redact(f"{type(exc).__name__}: {exc}")[:limit]


def _clean(value: Any) -> Any:
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return redact(str(value))[:500]


def log(level: str, msg: str, **fields: Any) -> None:
    record: dict[str, Any] = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "level": level, "msg": _clean(msg)}
    for key, value in fields.items():
        record[key] = "[OMITTED]" if key.lower() in _FORBIDDEN_KEYS else _clean(value)
    sys.stderr.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def info(msg: str, **fields: Any) -> None:
    log("INFO", msg, **fields)


def warning(msg: str, **fields: Any) -> None:
    log("WARNING", msg, **fields)


def error(msg: str, **fields: Any) -> None:
    log("ERROR", msg, **fields)
