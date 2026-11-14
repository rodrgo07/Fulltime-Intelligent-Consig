"""Garante que o fluxo FALSO dos testes ponta a ponta (D2) nunca chega à produção."""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path

import fake_engine
import pytest

from fic_rpa.workflows import PRODUCTION_WORKFLOWS

ENGINE = Path(__file__).resolve().parents[1]


def test_production_registry_has_no_fake_workflow() -> None:
    assert PRODUCTION_WORKFLOWS == {}
    assert fake_engine.FAKE_WORKFLOW_ID not in PRODUCTION_WORKFLOWS


def test_fake_engine_is_outside_the_package_and_sidecar() -> None:
    wheel = tomllib.loads((ENGINE / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["hatch"]["build"]["targets"]["wheel"]
    assert all(p.startswith("src/") for p in wheel["packages"])
    assert not list((ENGINE / "src").rglob("fake_engine*"))
    for script in (ENGINE / "scripts").glob("*.py"):
        assert "fake_engine" not in script.read_text(encoding="utf-8"), script.name


def test_fake_engine_refuses_to_run_without_test_flag(tmp_path: Path) -> None:
    env = {k: v for k, v in os.environ.items() if k != "FIC_FAKE_ENGINE_FOR_TESTS"}
    r = subprocess.run([sys.executable, str(ENGINE / "tests" / "fake_engine.py"), "--data-dir", str(tmp_path),
                        "--scenario", "ok"], env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode != 0
    assert "FIC_FAKE_ENGINE_FOR_TESTS=1" in r.stderr  # ASCII: independe do encoding do console


@pytest.mark.parametrize("scenario", sorted(fake_engine.SCENARIOS))
def test_fake_scenarios_are_valid_workflows(scenario: str) -> None:
    wf = fake_engine.build(scenario)
    wf.validate()
    assert sum(1 for s in wf.steps if s.side_effect) == 1
