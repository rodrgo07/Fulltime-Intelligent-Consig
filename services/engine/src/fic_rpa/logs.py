"""Logs estruturados em JSON no stderr (stdout é reservado ao protocolo JSON-RPC).

Regras: registrar apenas identificadores técnicos (job_id, request_id, step). Nunca o payload.
A redação abaixo é a última barreira caso algum dado pessoal escape para uma mensagem.
"""

from __future__ import annotations

import json
import re
import sys
import time
from typing import Any

LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40}
_min_level = LEVELS["INFO"]

_CPF = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_LONG_DIGITS = re.compile(r"\b\d{8,}\b")  # contas, documentos, telefones
_FORBIDDEN_KEYS = {"payload", "password", "senha", "token", "cpf", "document", "documento", "image", "screenshot"}


def redact(text: str) -> str:
    text = _CPF.sub("[REDACTED]", text)
    text = _EMAIL.sub("[REDACTED]", text)
    return _LONG_DIGITS.sub("[REDACTED]", text)


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        return redact(value)[:500]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return redact(str(value))[:200]


def set_level(level: str) -> None:
    global _min_level
    _min_level = LEVELS.get(level.upper(), LEVELS["INFO"])


def log(level: str, msg: str, **fields: Any) -> None:
    if LEVELS[level] < _min_level:
        return
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "level": level, "msg": _clean(msg)}
    for k, v in fields.items():
        record[k] = "[OMITTED]" if k.lower() in _FORBIDDEN_KEYS else _clean(v)
    sys.stderr.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def debug(msg: str, **f: Any) -> None:
    log("DEBUG", msg, **f)


def info(msg: str, **f: Any) -> None:
    log("INFO", msg, **f)


def warning(msg: str, **f: Any) -> None:
    log("WARNING", msg, **f)


def error(msg: str, **f: Any) -> None:
    log("ERROR", msg, **f)
