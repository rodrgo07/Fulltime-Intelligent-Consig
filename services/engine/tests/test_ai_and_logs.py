from __future__ import annotations

import asyncio
import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from conftest import FakeRuntime

from fic_ai import hardware, installer
from fic_ai.interpret import parse
from fic_ai.manifest import load_manifest
from fic_ai.service import AiService
from fic_rpa import logs
from fic_rpa.errors import Observation
from fic_rpa.workflow import Recovery

ALLOWED = ["escalate", "retry_step", "wait_and_retry"]
OBS = Observation(summary="popup", visible_text="Cliente 529.982.247-25", screenshot_png=b"\x89PNG")


def test_manifest_pins_official_runtime_hash() -> None:
    m = load_manifest()
    assert m.runtime.url.startswith("https://github.com/ollama/ollama/releases/download/")
    assert len(m.runtime.sha256) == 64
    assert all(c.vision for c in m.model_candidates)


@pytest.mark.parametrize("raw,ok", [
    ('{"situation":"x","action":"retry_step","confidence":0.9}', True),
    ('{"situation":"x","action":"rm -rf","confidence":0.9}', False),
    ('{"situation":"x","action":"retry_step","confidence":3}', False),
    ("não é json", False),
    ('{"situation":"x","action":"retry_step"}', False),
])
def test_ai_output_is_strictly_validated(raw: str, ok: bool) -> None:
    assert (parse(raw, ALLOWED) is not None) is ok


def test_recommendation_respects_system_reserve() -> None:
    cands = load_manifest().model_candidates
    assert hardware.recommend(cands, 6 * 1024) is None          # 6 GB: não sobra para IA
    small = hardware.recommend(cands, 12 * 1024)
    assert small is not None and small.approx_ram_mb <= (12 * 1024 - 4096) // 2
    assert hardware.recommend(cands, 32 * 1024).name == max(cands, key=lambda c: c.approx_ram_mb).name


def make_zip(path: Path, files: dict[str, bytes]) -> str:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    path.write_bytes(buf.getvalue())
    return hashlib.sha256(buf.getvalue()).hexdigest()


def spec_with(sha: str):
    return load_manifest().runtime.model_copy(update={"sha256": sha})


def test_installer_rejects_wrong_hash(tmp_path: Path) -> None:
    archive = tmp_path / "a.zip"
    make_zip(archive, {"ollama.exe": b"x"})
    with pytest.raises(installer.InstallError, match="SHA256_MISMATCH"):
        installer.verify_and_extract(archive, tmp_path / "ialocal", spec_with("0" * 64))
    assert not (tmp_path / "ialocal" / "bin").exists()


def test_installer_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "a.zip"
    sha = make_zip(archive, {"../../evil.exe": b"x", "ollama.exe": b"x"})
    with pytest.raises(installer.InstallError, match="UNSAFE_ARCHIVE"):
        installer.verify_and_extract(archive, tmp_path / "ialocal", spec_with(sha))


def test_installer_extracts_verified_archive(tmp_path: Path) -> None:
    archive = tmp_path / "a.zip"
    sha = make_zip(archive, {"ollama.exe": b"x", "lib/a.dll": b"y"})
    spec = spec_with(sha)
    installer.verify_and_extract(archive, tmp_path / "ialocal", spec)
    assert installer.is_installed(tmp_path / "ialocal", spec)


def ready_service(tmp_path: Path, runtime: FakeRuntime) -> AiService:
    svc = AiService(tmp_path / "ialocal", load_manifest(), runtime=runtime)
    spec = svc.manifest.runtime
    (tmp_path / "ialocal" / "bin").mkdir(parents=True)
    (tmp_path / "ialocal" / "bin" / spec.executable).write_bytes(b"x")
    (tmp_path / "ialocal" / "bin" / ".version").write_text(spec.version)
    svc.settings.enabled = True
    svc.settings.model = svc.manifest.model_candidates[0].name
    svc.settings.min_free_ram_mb = 1
    svc.settings.max_cpu_percent = 100
    return svc


async def test_ai_disabled_by_default(tmp_path: Path) -> None:
    rt = FakeRuntime()
    svc = AiService(tmp_path, load_manifest(), runtime=rt)
    assert svc.status()["state"] == "disabled"
    assert await svc.advise("s", ALLOWED, OBS) is None
    assert rt.starts == 0


async def test_ai_loads_on_demand_and_unloads_after(tmp_path: Path) -> None:
    rt = FakeRuntime()
    svc = ready_service(tmp_path, rt)
    advice = await svc.advise("s", ALLOWED, OBS)
    assert advice is not None and advice.action is Recovery.RETRY_STEP
    assert rt.starts == 1 and rt.stops == 1 and rt.running is False


async def test_ai_unloads_even_on_timeout(tmp_path: Path) -> None:
    rt = FakeRuntime()
    rt.delay = 1
    svc = ready_service(tmp_path, rt)
    svc.settings.timeout_s = 0.05
    assert await svc.advise("s", ALLOWED, OBS) is None
    assert rt.running is False
    assert svc.last_error == "TimeoutError"


async def test_single_inference_at_a_time(tmp_path: Path) -> None:
    rt = FakeRuntime()
    rt.delay = 0.2
    svc = ready_service(tmp_path, rt)
    a, b = await asyncio.gather(svc.advise("s", ALLOWED, OBS), svc.advise("s", ALLOWED, OBS))
    assert [x is None for x in (a, b)].count(True) == 1
    assert rt.starts == 1


async def test_ai_skipped_when_memory_low(tmp_path: Path) -> None:
    rt = FakeRuntime()
    svc = ready_service(tmp_path, rt)
    svc.settings.min_free_ram_mb = 10**9
    assert await svc.advise("s", ALLOWED, OBS) is None
    assert svc.last_error == "LOW_MEMORY" and rt.starts == 0


def test_logs_redact_personal_data(capsys: pytest.CaptureFixture[str]) -> None:
    logs.info("cliente 529.982.247-25 email a@b.com conta 123456789", payload={"cpf": "1"}, job_id="j1")
    rec = json.loads(capsys.readouterr().err.strip())
    assert "529" not in rec["msg"] and "a@b.com" not in rec["msg"] and "123456789" not in rec["msg"]
    assert rec["payload"] == "[OMITTED]"
    assert rec["job_id"] == "j1"


def test_debug_hidden_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    logs.set_level("INFO")
    logs.debug("x")
    assert capsys.readouterr().err == ""
