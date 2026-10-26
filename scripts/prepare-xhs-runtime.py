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
import os
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


def validate_runtime_links(directory):
    root = directory.resolve(strict=True)
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            link = Path(current) / name
            if not link.is_symlink():
                continue
            relative = link.relative_to(root)
            target = link.readlink()
            # A self-contained runtime must remain portable after relocation.
            if target.is_absolute():
                raise RuntimeError(f"Runtime symlink must be relative: {relative}")
            lexical_target = Path(os.path.abspath(link.parent / target))
            if not lexical_target.is_relative_to(root):
                raise RuntimeError(f"Runtime symlink escapes its root: {relative}")
            try:
                resolved = link.resolve(strict=True)
            except (OSError, RuntimeError):
                raise RuntimeError(f"Runtime symlink is broken or cyclic: {relative}") from None
            if not resolved.is_relative_to(root):
                raise RuntimeError(f"Runtime symlink escapes its root: {relative}")
        framework = Path(current)
        versions = framework / "Versions"
        if framework.name == "Python.framework" and versions.exists():
            current_version = versions / "Current"
            valid = versions.is_dir() and current_version.is_symlink()
            if valid:
                version_alias = current_version.readlink()
                valid = (len(version_alias.parts) == 1 and version_alias.name not in (".", "..")
                         and current_version.resolve().parent == versions.resolve())
            for name in ("Python", "Resources"):
                alias = framework / name
                valid = valid and alias.is_symlink() and alias.readlink() == Path("Versions/Current") / name
            valid = valid and (framework / "Python").is_file() and (framework / "Resources").is_dir()
            if not valid:
                raise RuntimeError("Versioned Python.framework layout is invalid; rebuild the XHS Python runtime: "
                                   + str(framework.relative_to(root)))


def copy_runtime(source, destination):
    validate_runtime_links(source)
    # PyInstaller's macOS frameworks require their relative link layout for
    # codesign. Dereferencing creates ambiguous framework/application bundles.
    shutil.copytree(source, destination, dirs_exist_ok=True, symlinks=True)
    if sys.platform == "win32":
        # CPython 3.12 copytree can create a file-link for a relative directory
        # target not copied yet. Restore its type from the validated source.
        source_root = source.resolve(strict=True)
        for current, directories, files in os.walk(source_root, followlinks=False):
            for name in directories + files:
                link = Path(current) / name
                if link.is_symlink() and link.is_dir():
                    copied = destination / link.relative_to(source_root)
                    copied.unlink()
                    copied.symlink_to(link.readlink(), target_is_directory=True)
                    shutil.copystat(link, copied, follow_symlinks=False)
    validate_runtime_links(destination)


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
        validate_runtime_links(target)
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
            copy_runtime(imported, stage)
        else:
            environment = runtime / "build-venv"
            if not (environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")).is_file():
                venv.EnvBuilder(with_pip=True).create(environment)
            python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
            subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", f"pyinstaller=={PYINSTALLER_VERSION}", f"certifi=={CERTIFI_VERSION}"], check=True)
            subprocess.run([str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "xhs-python", "--distpath", str(runtime / "build"), "--workpath", str(runtime / "work"), "--specpath", str(runtime), "--paths", str(SOURCE), "--collect-data", "certifi", str(SOURCE / "python-worker.py")], cwd=ROOT, check=True)
            copy_runtime(runtime / "build/xhs-python", stage)
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
