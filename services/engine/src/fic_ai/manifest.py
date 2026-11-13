from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from pydantic import BaseModel, Field


class RuntimeSpec(BaseModel):
    name: str
    version: str
    url: str = Field(pattern=r"^https://github\.com/ollama/ollama/releases/download/")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int
    executable: str


class ModelCandidate(BaseModel):
    name: str
    approx_ram_mb: int
    vision: bool
    note: str = ""


class Manifest(BaseModel):
    schema_: int = Field(alias="schema")
    runtime: RuntimeSpec
    model_candidates: list[ModelCandidate]


def manifest_path() -> Path:
    """Ordem: variável de ambiente → arquivo empacotado (PyInstaller) → ialocal/ do repositório."""
    if env := os.environ.get("FIC_IALOCAL_MANIFEST"):
        return Path(env)
    bundled = Path(getattr(sys, "_MEIPASS", "")) / "ialocal" / "manifest.json"
    if bundled.is_file():
        return bundled
    return Path(__file__).resolve().parents[4] / "ialocal" / "manifest.json"


def load_manifest(path: Path | None = None) -> Manifest:
    return Manifest.model_validate(json.loads((path or manifest_path()).read_text(encoding="utf-8")))
