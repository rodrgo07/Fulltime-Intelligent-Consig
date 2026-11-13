"""Prompt e validação da resposta da IA.

A IA devolve apenas JSON com uma ação de uma lista fechada. Ela não recebe ferramentas, não gera
seletores/coordenadas/comandos e não decide dados do cliente.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field, ValidationError


class Interpretation(BaseModel):
    situation: str = Field(max_length=300)
    action: str
    confidence: float = Field(ge=0, le=1)


def response_schema(allowed: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "situation": {"type": "string"},
            "action": {"type": "string", "enum": allowed},
            "confidence": {"type": "number"},
        },
        "required": ["situation", "action", "confidence"],
    }


def build_prompt(step: str, allowed: list[str], visible_text: str) -> str:
    return (
        "Você auxilia um robô de automação a entender uma tela inesperada de um sistema web.\n"
        f"Etapa em andamento: {step}.\n"
        f"Escolha UMA ação dentre: {', '.join(allowed)}.\n"
        "- retry_step: a tela é transitória (carregando, aviso que some) e repetir a etapa é seguro.\n"
        "- wait_and_retry: o sistema está lento/indisponível momentaneamente.\n"
        "- escalate: qualquer outra situação, dúvida, erro de negócio, dado faltante ou risco.\n"
        "Nunca invente dados. Na dúvida, escolha escalate com confiança baixa.\n"
        'Responda apenas JSON: {"situation": "...", "action": "...", "confidence": 0.0-1.0}.\n'
        f"Texto visível da tela (pode estar truncado):\n{visible_text[:4000]}"
    )


def parse(raw: str, allowed: list[str]) -> Interpretation | None:
    try:
        data = json.loads(raw)
        out = Interpretation.model_validate(data)
    except (json.JSONDecodeError, ValidationError):
        return None
    return out if out.action in allowed else None
