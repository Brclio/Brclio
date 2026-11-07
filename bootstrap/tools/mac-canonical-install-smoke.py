"""Install the official client and verify its absolute destination on a disposable macOS runner."""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

CANONICAL = Path("/Applications/Brclio.app")
APP_ID = "com.brclio.toolbox"
ROOT = Path(__file__).resolve().parents[2]


def run(*args, **options):
    return subprocess.check_output([str(arg) for arg in args], text=True, **options).strip()


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


PROCESS_SNAPSHOT = '''ObjC.import("AppKit");
function hasExited(app) {
    try { return !app || app.isNil() || app.terminated; }
    catch (error) { return false; }
}
function inspect(app) {
    let pid = null;
    try {
        if (hasExited(app)) return null;
        pid = app.processIdentifier;
        const url = app.bundleURL;
        const value = url && !url.isNil() ? ObjC.unwrap(url.path) : null;
        const path = typeof value === "string" && value.startsWith("/") && pid > 0 ? value : null;
        const ready = app.finishedLaunching;
        if (hasExited(app)) return null;
        return {pid, path, ready};
    } catch (error) {
        if (hasExited(app)) return null;
        return {pid, path:null, ready:false};
    }
}
function run(args) {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(args[0]).js;
    const rows = apps.map(app => ({app, entry:inspect(app)})).filter(row => row.entry);
    const result = rows.map(row => row.entry);
    if (!args[1] || result.some(entry => entry.path === null)) return JSON.stringify(result);
    for (const {app, entry} of rows) {
        if (entry.path !== args[1]) continue;
        const current = inspect(app);
        if (!current) continue;
        if (current.pid !== entry.pid || current.path !== args[1]) {
            return JSON.stringify([{pid:current.pid, path:null, ready:false}]);
        }
        try { app.terminate; } catch (error) { if (!hasExited(app)) throw error; }
    }
    return JSON.stringify(result);
}'''


def processes(quit_path=None):
    # A matching record without a bundle URL may be between launch and exit.
    # Only a fresh, fully identified snapshot may authorize cleanup.
    deadline = time.monotonic() + 5
    while True:
        result = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", PROCESS_SNAPSHOT,
                                 APP_ID, str(quit_path) if quit_path else ""], text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(f"CI Launch Services observer failed: {result.stderr.strip()}")
        try:
            rows = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("CI Launch Services observer returned invalid process data") from error
        unknown = [row for row in rows if not row["path"]]
        if not unknown:
            return rows
        if time.monotonic() >= deadline:
            pids = [row["pid"] for row in unknown]
            raise RuntimeError(f"CI Launch Services observer could not identify matching processes {pids}")
        time.sleep(0.2)


def wait(check, timeout=45):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        result = check()
        if result:
            return result
        time.sleep(0.3)
    raise RuntimeError("Timed out checking Brclio process state")


def running(path):
    for app in processes():
        if Path(app["path"]).resolve() == path and app["ready"]:
            return app["pid"]
    return None


def quit_owned(path):
    processes(quit_path=path)
    wait(lambda: all(Path(p["path"]).resolve() != path for p in processes()))


def snapshot(path):
    s = path.stat()
    return (s.st_dev, s.st_ino, s.st_mtime_ns, sha(path / "Contents/Info.plist"),
            sha(path / "Contents/MacOS/Brclio"))


def fixture(home):
    bundle = home / "Applications/Brclio.app"
    exe = bundle / "Contents/MacOS/Brclio"
    exe.parent.mkdir(parents=True)
    plist = dict(CFBundleName="Brclio", CFBundleIdentifier=APP_ID, CFBundlePackageType="APPL",
                 CFBundleExecutable="Brclio", CFBundleShortVersionString="999.0.0",
                 CFBundleVersion="999.0.0", LSUIElement=True)
    (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps(plist))
    code = '#import <AppKit/AppKit.h>\nint main(void){ @autoreleasepool { [[NSApplication sharedApplication] run]; } return 0; }'
    run("xcrun", "clang", "-x", "objective-c", "-", "-framework", "AppKit", "-o", exe, input=code)
    run("codesign", "--force", "--sign", "-", bundle)
    return bundle


def official_release(work, target, requested=None):
    route = "tags/" + requested if requested else "latest"
    release = json.loads(run("gh", "api", f"repos/Brclio/Brclio/releases/{route}"))
    tag = release["tag_name"]
    if release["draft"] or release["prerelease"] or not re.fullmatch(r"v?\d+\.\d+\.\d+", tag):
        raise ValueError("Invalid stable GitHub tag")
    version = tag.lstrip("v")
    name = f"Brclio-{version}-{target}.dmg"
    assets = [a for a in release["assets"] if a["name"] == name]
    if len(assets) != 1:
        raise ValueError("Official release missing the platform installer")
    if requested and tag != requested:
        raise ValueError("Unexpected baseline release tag")
    if not requested and os.getenv("BRCLIO_TEST_OFFICIAL_DMG"):
        dmg = Path(os.environ["BRCLIO_TEST_OFFICIAL_DMG"])
        if dmg.name != name or os.environ.get("BRCLIO_TEST_OFFICIAL_VERSION") != version:
            raise ValueError("Previously fetched installer differs from current release")
    else:
        directory = work / tag
        directory.mkdir()
        run("gh", "release", "download", tag, "--repo", "Brclio/Brclio", "--dir", directory,
            "--pattern", name, "--pattern", "SHA256SUMS.txt")
        dmg = directory / name
    manifest = (dmg.parent / "SHA256SUMS.txt").read_text().splitlines()
    hashes = [line.split()[0] for line in manifest if line.split()[1:] == [name]]
    if len(hashes) != 1 or not re.fullmatch(r"[0-9a-f]{64}", hashes[0]) or sha(dmg) != hashes[0]:
        raise ValueError("Invalid official SHA256SUMS")
    if assets[0]["size"] != dmg.stat().st_size or assets[0]["digest"] != "sha256:" + hashes[0]:
        raise ValueError("Installer differs from official GitHub size/digest")
    return tag, version, dmg, hashes[0]


def verify_app(path, version):
    plist = plistlib.loads((path / "Contents/Info.plist").read_bytes())
    assert plist["CFBundleIdentifier"] == APP_ID and plist["CFBundleShortVersionString"] == version
    run("codesign", "--verify", "--deep", "--strict", path)
    return snapshot(path)


def remove_owned(owned):
    if snapshot(CANONICAL)[:2] != owned:
        raise RuntimeError("Refusing to remove an unexpected system bundle")
    quit_owned(CANONICAL)
    if snapshot(CANONICAL)[:2] != owned:
        raise RuntimeError("System bundle changed during cleanup")
    shutil.rmtree(CANONICAL)


def install_baseline(work, dmg, version):
    mount = work / "old-image"
    mount.mkdir()
    run("hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg)
    try:
        bundle = mount / "Brclio.app"
        verify_app(bundle, version)
        CANONICAL.mkdir()  # Exclusive reservation; never clobber another installation.
        run("ditto", "--rsrc", "--extattr", "--acl", bundle, CANONICAL)
        return verify_app(CANONICAL, version)
    finally:
        run("hdiutil", "detach", mount)


def helper_error(value):
    # Helper invocations can contain the private 64-hex launch token. Keep a
    # short error summary, never print arguments, configuration or whole logs.
    line = str(value).splitlines()[0] if value else ""
    line = re.sub(r"(?i)\b[0-9a-f]{64}\b", "[redacted]", line)
    return line.partition("--brclio-update-token")[0][:280]


def helper_diagnostics(jobs):
    if not jobs.is_dir() or jobs.resolve() != jobs:
        return "No install-jobs directory in this run's private profile"
    details = []
    for job in jobs.glob("mac-*"):
        if not job.is_dir() or job.resolve() != job:
            continue
        hints = []
        for name, keys in [("state.json", ("phase",)), ("result.json", ("status", "phase", "error"))]:
            file = job / name
            if file.is_file() and not file.is_symlink():
                record = json.loads(file.read_text())
                hints.extend(f"{key}={helper_error(record[key])}" for key in keys if key in record)
        log = job / "helper.log"
        if log.is_file() and not log.is_symlink():
            errors = [helper_error(line) for line in log.read_text(errors="replace").splitlines()
                      if line.startswith(("Error:", "Waiting for startup acknowledgement:", "Update journal failed:"))]
            hints.extend(dict.fromkeys(errors[-2:]))
        details.append(", ".join(hints) or "No stage or error recorded")
    return "; ".join(details) or "No helper job in this run's private profile"


def check_helper_result(profile, version):
    jobs = profile / "updates/install-jobs"
    def receipt():
        for result in jobs.glob("mac-*/result.json"):
            recorded = json.loads(result.read_text())
            if recorded["status"] != "installed":
                raise RuntimeError("Upgrade helper reported failure")
            assert recorded["current"] == str(CANONICAL) and recorded["version"] == version
            assert recorded["appId"] == APP_ID and recorded["launchAcknowledged"] is True
            ack = json.loads((result.parent / "launch-ack.json").read_text())
            assert ack["executable"] == str(CANONICAL / "Contents/MacOS/Brclio") and ack["version"] == version
            return ack["pid"]
        return None
    try:
        return wait(receipt, 180)
    except (RuntimeError, AssertionError) as error:
        raise RuntimeError(f"{error}; {helper_diagnostics(jobs)}") from error


def smoke(edition, target):
    if (os.getenv("GITHUB_ACTIONS"), os.getenv("RUNNER_OS"), os.getenv("RUNNER_ENVIRONMENT"),
            platform.system()) != ("true", "macOS", "github-hosted", "Darwin"):
        raise RuntimeError("Requires a disposable GitHub-hosted macOS runner")
    if edition not in ("full", "lite") or target not in ("mac-arm64", "mac-x64"):
        raise ValueError("Unsupported edition or architecture")
    if os.path.lexists(CANONICAL) or os.path.lexists(Path.home() / "Applications/Brclio.app") or processes():
        raise RuntimeError("Refusing to modify an existing installation or process")
    temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="brclio-canonical-", dir=temp) as scratch:
        work = Path(scratch)
        tag, version, dmg, digest = official_release(work, target)
        _, baseline, old_dmg, _ = official_release(work, target, "v0.2.7")
        if tuple(map(int, version.split("."))) <= tuple(map(int, baseline.split("."))):
            raise ValueError("Stable release must be newer than the upgrade baseline")
        home = work / "home"
        legacy = fixture(home)
        before = snapshot(legacy)
        env = {k:v for k,v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN")}
        env.update(HOME=str(home), CFFIXED_USER_HOME=str(home), BRCLIO_CANONICAL_SMOKE_DIR=str(work),
                   BRCLIO_USER_DATA=str(work / "profile"), BRCLIO_CANONICAL_RELEASE_TAG=tag,
                   BRCLIO_CANONICAL_BASELINE=baseline,
                   BRCLIO_TEST_OFFICIAL_VERSION=version, BRCLIO_TEST_OFFICIAL_DMG=str(dmg),
                   BRCLIO_TEST_OFFICIAL_SHA=digest)
        if edition == "lite":
            driver = work / "install.test"
            run("go", "test", "-c", "-o", driver, ".", cwd=ROOT / "lite")
            def invoke(value):
                subprocess.run([driver, "-test.run", "^TestCanonicalApplicationsOnMacRunner$", "-test.v"],
                               env={**env, "BRCLIO_CANONICAL_PHASE":value}, check=True)
        else:
            folder = "mac-arm64" if target == "mac-arm64" else "mac"
            app = ROOT / "release/downloader" / folder / "Brclio Downloader.app/Contents"
            def invoke(value):
                subprocess.run([app / "MacOS/Brclio Downloader", ROOT / "bootstrap/tools/mac-canonical-install-smoke.cjs", value],
                               env={**env, "BRCLIO_CANONICAL_ASAR":str(app / "Resources/app.asar"), "ELECTRON_RUN_AS_NODE":"1"}, check=True)
        owned = None
        def phase(value):
            print(f"{edition} {value} → {CANONICAL}", flush=True)
            invoke(value)

        def check_current(installed, first_pid):
            phase("current")
            assert snapshot(CANONICAL) == installed and before == snapshot(legacy)
            assert running(CANONICAL) == first_pid and not running(legacy)

        try:
            run("/usr/bin/open", "-n", "-a", legacy, env=env)
            legacy_pid = wait(lambda: running(legacy))
            phase("blocked")
            assert running(legacy) == legacy_pid and not os.path.lexists(CANONICAL)
            quit_owned(legacy)

            phase("fresh")
            installed = verify_app(CANONICAL, version)
            owned = installed[:2]
            first_pid = wait(lambda: running(CANONICAL))
            assert before == snapshot(legacy)

            check_current(installed, first_pid)
            print(f"Verified {edition}: {tag} installed and opened {CANONICAL} (PID {first_pid}); "
                  "same-version action preserved global bundle, and legacy copy was never replaced or reopened.", flush=True)

            remove_owned(owned)
            old = install_baseline(work, old_dmg, baseline)
            owned = old[:2]
            env["BRCLIO_USER_DATA"] = str(work / "upgrade-profile")
            run("/usr/bin/open", "-n", "-a", CANONICAL, "--env",
                "BRCLIO_USER_DATA=" + env["BRCLIO_USER_DATA"], env=env)
            old_pid = wait(lambda: running(CANONICAL))
            print(f"Starting {edition} upgrade from running {baseline}, PID {old_pid} at {CANONICAL}", flush=True)
            try:
                phase("upgrade")
            except subprocess.CalledProcessError:
                if edition == "full":
                    print(helper_diagnostics(Path(env["BRCLIO_USER_DATA"]) / "updates/install-jobs"), flush=True)
                raise
            receipt_pid = check_helper_result(Path(env["BRCLIO_USER_DATA"]), version) if edition == "full" else None
            if edition == "full":
                assert not (home / "Library/Application Support" / APP_ID / "updates/install-jobs").exists()
            upgraded = verify_app(CANONICAL, version)
            assert upgraded[:2] != owned and before == snapshot(legacy)
            owned = upgraded[:2]
            new_pid = wait(lambda: running(CANONICAL))
            assert new_pid != old_pid and (receipt_pid is None or receipt_pid == new_pid)
            check_current(upgraded, new_pid)
            print(f"Verified {edition}: running {baseline} (PID {old_pid}) upgraded to {version} "
                  f"(PID {new_pid}) at {CANONICAL}; next run only opened it; legacy fixture preserved.")
        finally:
            failure = sys.exc_info()[1]
            try:
                if running(legacy):
                    quit_owned(legacy)
                # Only the proven newly created bundle may be removed.
                if owned and CANONICAL.is_dir() and snapshot(CANONICAL)[:2] == owned:
                    remove_owned(owned)
            except Exception as cleanup_error:
                if failure is None:
                    raise
                print(f"CI cleanup also failed: {cleanup_error}", file=sys.stderr)


if __name__ == "__main__":
    smoke(*sys.argv[1:])
