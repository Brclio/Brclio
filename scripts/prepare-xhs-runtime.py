"""Build a self-contained XHS Python worker for the current native platform.

Run with Python 3.10+ on each target architecture before electron-builder. The
runtime stays in ignored runtime/<mac|win|linux>-<arm64|x64>/python and is copied
into resources/xhs-python by electron-builder. No end-user Python is required.

For a prepared runtime from a trusted local build, pass --copy-from /path/python.
The current project's worker and API sources are always used when freezing; an
imported frozen worker must match these sources (build-info source fingerprint).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import venv

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "desktop/xhs"
PYINSTALLER_VERSION = "6.22.3"
CERTIFI_VERSION = "2026.7.22"


def native_target():
    architecture = {"AMD64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine(), platform.machine())
    return f'{ {"darwin": "mac", "win32": "win"}.get(sys.platform, "linux") }-{architecture}'


def source_fingerprint():
    paths = [SOURCE / "python-worker.py", *(SOURCE / "api" / name for name in ["python_parse.py", "python_image.py", "python_video.py"])]
    digest = hashlib.sha256()
    for filename in paths:
        if not filename.is_file():
            raise RuntimeError(f"Missing XHS Python source: {filename}")
        digest.update(filename.relative_to(SOURCE).as_posix().encode())
        digest.update(filename.read_bytes())
    return digest.hexdigest()


def health(directory):
    frozen = directory / ("xhs-python.exe" if sys.platform == "win32" else "xhs-python")
    if frozen.is_file():
        command = [str(frozen), "--health"]
    else:
        embedded = directory / "python.exe"
        worker = directory / "python-worker.py"
        if not embedded.is_file() or not worker.is_file():
            raise RuntimeError(f"Missing self-contained Python executable in {directory}")
        command = [str(embedded), str(worker), "--health"]
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
    payload = json.loads(result.stdout)
    if payload.get("ok") is not True or payload.get("engine") != "python":
        raise RuntimeError("Bundled Python failed its health check")
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--copy-from", type=Path, help="Reuse a matching previously built runtime directory")
    parser.add_argument("--check", action="store_true", help="Validate an existing runtime without installing or building")
    args = parser.parse_args()
    fingerprint = source_fingerprint()
    runtime = ROOT / "runtime" / native_target()
    target = runtime / "python"
    if args.check:
        info = json.loads((runtime / "build-info.json").read_text())
        if info.get("sourceSha256") != fingerprint:
            raise RuntimeError("Python source changed; rebuild the XHS runtime before packaging")
        print(json.dumps({"runtime": str(target), "health": health(target), "sourceSha256": fingerprint}))
        return
    runtime.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="python-stage-", dir=runtime))
    try:
        if args.copy_from:
            imported = args.copy_from.expanduser().resolve()
            info_path = imported.parent / "build-info.json"
            info = json.loads(info_path.read_text()) if info_path.is_file() else {}
            if info.get("sourceSha256") != fingerprint or info.get("target") != native_target():
                raise RuntimeError("Imported frozen runtime must have matching build-info sourceSha256 and target; rebuild from current sources instead")
            shutil.copytree(imported, stage, dirs_exist_ok=True)
        else:
            environment = runtime / "build-venv"
            if not (environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")).is_file():
                venv.EnvBuilder(with_pip=True).create(environment)
            python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
            subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", f"pyinstaller=={PYINSTALLER_VERSION}", f"certifi=={CERTIFI_VERSION}"], check=True)
            subprocess.run([str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "xhs-python", "--distpath", str(runtime / "build"), "--workpath", str(runtime / "work"), "--specpath", str(runtime), "--paths", str(SOURCE), "--collect-data", "certifi", str(SOURCE / "python-worker.py")], cwd=ROOT, check=True)
            shutil.copytree(runtime / "build/xhs-python", stage, dirs_exist_ok=True)
        result = health(stage)
        # Replace only after a successful native health check, preserving the old
        # usable runtime if compilation or freezing failed.
        if target.exists():
            shutil.rmtree(target)
        stage.replace(target)
        (runtime / "build-info.json").write_text(json.dumps({"target": native_target(), "platform": sys.platform, "arch": native_target().rsplit("-", 1)[1], "pythonVersion": result.get("version"), "sourceSha256": fingerprint, "pyinstaller": PYINSTALLER_VERSION, "certifi": CERTIFI_VERSION}, indent=2) + "\n", encoding="utf-8")
        print(f"Bundled XHS Python ready: {target}")
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    main()
