"""Gera o sidecar do Tauri: apps/desktop/src-tauri/binaries/fic-engine-<target>.exe

Uso: uv run python scripts/build_sidecar.py
O Chrome NÃO é embutido (usa o Google Chrome instalado); só o driver do Playwright vai junto.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
TARGET = "x86_64-pc-windows-msvc"
OUT = REPO / "apps" / "desktop" / "src-tauri" / "binaries"

cmd = [
    sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--console",
    "--name", f"fic-engine-{TARGET}",
    "--paths", str(ROOT / "src"),
    "--collect-data", "playwright",
    "--collect-submodules", "fic_rpa",
    "--distpath", str(OUT),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
    str(ROOT / "scripts" / "entry.py"),
]
raise SystemExit(subprocess.call(cmd, cwd=ROOT))
