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


def processes():
    script = '''ObjC.import("AppKit");
    JSON.stringify($.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.brclio.toolbox").js.map(a =>
      ({path:a.bundleURL.path.js, pid:a.processIdentifier, ready:a.finishedLaunching})))'''
    return json.loads(run("/usr/bin/osascript", "-l", "JavaScript", "-e", script))


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
    # LaunchServices termination is restricted to this exact test bundle.
    script = '''ObjC.import("AppKit"); function run(args) {
        $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.brclio.toolbox").js
        .filter(a => a.bundleURL.path.js === args[0]).forEach(a => a.terminate);
    }'''
    run("/usr/bin/osascript", "-l", "JavaScript", "-e", script, path)
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


def check_helper_result(profile, version):
    jobs = profile / "updates/install-jobs"
    def receipt():
        for result in jobs.glob("mac-*/result.json"):
            recorded = json.loads(result.read_text())
            if recorded["status"] != "installed":
                raise RuntimeError(f"Upgrade helper failed: {recorded}")
            assert recorded["current"] == str(CANONICAL) and recorded["version"] == version
            assert recorded["appId"] == APP_ID and recorded["launchAcknowledged"] is True
            ack = json.loads((result.parent / "launch-ack.json").read_text())
            assert ack["executable"] == str(CANONICAL / "Contents/MacOS/Brclio") and ack["version"] == version
            return ack["pid"]
        return None
    return wait(receipt, 180)


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
            def phase(value):
                subprocess.run([driver, "-test.run", "^TestCanonicalApplicationsOnMacRunner$", "-test.v"],
                               env={**env, "BRCLIO_CANONICAL_PHASE":value}, check=True)
        else:
            folder = "mac-arm64" if target == "mac-arm64" else "mac"
            app = ROOT / "release/downloader" / folder / "Brclio Downloader.app/Contents"
            def phase(value):
                subprocess.run([app / "MacOS/Brclio Downloader", ROOT / "bootstrap/tools/mac-canonical-install-smoke.cjs", value],
                               env={**env, "BRCLIO_CANONICAL_ASAR":str(app / "Resources/app.asar"), "ELECTRON_RUN_AS_NODE":"1"}, check=True)
        owned = None
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
                  "same-version action preserved global bundle, and legacy copy was never replaced or reopened.")

            remove_owned(owned)
            old = install_baseline(work, old_dmg, baseline)
            owned = old[:2]
            env["BRCLIO_USER_DATA"] = str(work / "upgrade-profile")
            run("/usr/bin/open", "-n", "-a", CANONICAL, "--env",
                "BRCLIO_USER_DATA=" + env["BRCLIO_USER_DATA"], env=env)
            old_pid = wait(lambda: running(CANONICAL))
            phase("upgrade")
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
            if running(legacy):
                quit_owned(legacy)
            # Only the proven newly created bundle may be removed. Anything else
            # is left alone; even an interrupted test runs on a disposable VM.
            if owned and CANONICAL.is_dir() and snapshot(CANONICAL)[:2] == owned:
                remove_owned(owned)


if __name__ == "__main__":
    smoke(*sys.argv[1:])
