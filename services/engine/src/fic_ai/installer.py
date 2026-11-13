"""Download verificado do Ollama portátil para <data>/ialocal/bin.

Só extrai se o SHA-256 conferir com o manifesto. Arquivo temporário é removido em qualquer falha.
"""

from __future__ import annotations

import hashlib
import shutil
import zipfile
from collections.abc import Callable
from pathlib import Path

import httpx

from fic_rpa import logs

from .manifest import RuntimeSpec


class InstallError(Exception):
    pass


def runtime_executable(ialocal: Path, spec: RuntimeSpec) -> Path:
    return ialocal / "bin" / spec.executable


def is_installed(ialocal: Path, spec: RuntimeSpec) -> bool:
    marker = ialocal / "bin" / ".version"
    return runtime_executable(ialocal, spec).is_file() and marker.is_file() and marker.read_text() == spec.version


def verify_and_extract(archive: Path, ialocal: Path, spec: RuntimeSpec) -> None:
    digest = hashlib.sha256()
    with archive.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != spec.sha256:
        raise InstallError("SHA256_MISMATCH")
    target = ialocal / "bin"
    staging = ialocal / "bin.new"
    shutil.rmtree(staging, ignore_errors=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.namelist():
            # Bloqueia path traversal no zip.
            dest = (staging / member).resolve()
            if not dest.is_relative_to(staging.resolve()):
                raise InstallError("UNSAFE_ARCHIVE")
        z.extractall(staging)
    if not (staging / spec.executable).is_file():
        shutil.rmtree(staging, ignore_errors=True)
        raise InstallError("EXECUTABLE_NOT_FOUND")
    (staging / ".version").write_text(spec.version)
    shutil.rmtree(target, ignore_errors=True)
    staging.rename(target)


def install(ialocal: Path, spec: RuntimeSpec, progress: Callable[[int, int], None] | None = None) -> None:
    ialocal.mkdir(parents=True, exist_ok=True)
    (ialocal / "models").mkdir(exist_ok=True)
    tmp = ialocal / "download.partial"
    try:
        with httpx.stream("GET", spec.url, follow_redirects=True, timeout=httpx.Timeout(30, read=120)) as r:
            r.raise_for_status()
            done = 0
            with tmp.open("wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    if done > spec.size_bytes * 1.05:
                        raise InstallError("SIZE_EXCEEDED")
                    if progress:
                        progress(done, spec.size_bytes)
        verify_and_extract(tmp, ialocal, spec)
        logs.info("ai runtime installed", version=spec.version)
    finally:
        tmp.unlink(missing_ok=True)
