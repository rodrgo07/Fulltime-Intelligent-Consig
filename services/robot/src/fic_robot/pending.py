"""Resultados gerados no Consig que ainda não foram confirmados pelo banco.

Gravado ANTES de chamar complete_job e removido só depois que o banco confirma. Enquanto houver item aqui,
o robô não reserva job novo. Gravação atômica: arquivo temporário + os.replace.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class PendingResult:
    job_id: str
    request_id: str
    adhesion_number: str
    result_status: str = "GERADA"
    external_operation_id: str | None = None


class PendingResults:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> list[PendingResult]:
        if not self.path.exists():
            return []
        raw = json.loads(self.path.read_text(encoding="utf-8") or "[]")
        return [PendingResult(**item) for item in raw]

    def _write(self, items: list[PendingResult]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps([asdict(i) for i in items], ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def add(self, item: PendingResult) -> None:
        items = [i for i in self.load() if i.job_id != item.job_id]
        self._write([*items, item])

    def remove(self, job_id: str) -> None:
        self._write([i for i in self.load() if i.job_id != job_id])

    def __bool__(self) -> bool:
        return bool(self.load())
