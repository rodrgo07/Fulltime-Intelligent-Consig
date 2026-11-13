"""Avaliação do hardware do backoffice para sugerir (não impor) um modelo."""

from __future__ import annotations

import os

import psutil

from .manifest import ModelCandidate

# A IA não pode disputar memória com o Chrome/Consig e o Windows.
RESERVED_FOR_SYSTEM_MB = 4096


def snapshot() -> dict[str, float | int]:
    vm = psutil.virtual_memory()
    return {
        "total_ram_mb": vm.total // 2**20,
        "available_ram_mb": vm.available // 2**20,
        "cpu_count": os.cpu_count() or 1,
        "cpu_percent": psutil.cpu_percent(interval=0.2),
    }


def recommend(candidates: list[ModelCandidate], total_ram_mb: int) -> ModelCandidate | None:
    """Maior modelo de visão que cabe em até metade da RAM que sobra após a reserva do sistema."""
    budget = max(0, total_ram_mb - RESERVED_FOR_SYSTEM_MB) // 2
    fitting = [c for c in candidates if c.vision and c.approx_ram_mb <= budget]
    return max(fitting, key=lambda c: c.approx_ram_mb, default=None)
