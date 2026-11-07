"""Verify an installed Lite bundle through normal macOS LaunchServices entry points.

Used on clean macOS CI runners. For local development an isolated fixture with
a com.brclio.dockprobe.* identifier can replace its browser/installer callbacks.
Such fixtures can record browser-open receipts in $HOME/browser-opens, one per line.
"""
import json
import os
from pathlib import Path
import plistlib
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class RejectConnect(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        if self.rfile.readline(4096).startswith(b"CONNECT "):
            self.server.saw_connect.set()
            self.wfile.write(b"HTTP/1.1 403 Local smoke test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")


def wait_for(check, description, seconds=35):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.25)
    raise RuntimeError("Timed out waiting for " + description)


def verify(bundle):
    info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
    identifier = info["CFBundleIdentifier"]
    fixture = identifier.startswith("com.brclio.dockprobe.")
    if not fixture and (identifier != "com.brclio.downloader.lite" or os.getenv("GITHUB_ACTIONS") != "true"
                        or os.getenv("RUNNER_OS") != "macOS"):
        raise RuntimeError("Use the packaged normal-launch test on a disposable macOS Actions runner")
    if not fixture and any(p.exists() for p in (Path("/Applications/Brclio.app"), Path.home() / "Applications/Brclio.app")):
        raise RuntimeError("Refusing to exercise installation on a pre-existing Brclio desktop")
    with tempfile.TemporaryDirectory(prefix="brclio-dock-check-") as directory, socketserver.ThreadingTCPServer(
            ("127.0.0.1", 0), RejectConnect) as reject:
        home = Path(directory).resolve()
        reject.saw_connect = threading.Event()
        threading.Thread(target=reject.serve_forever, daemon=True).start()
        proxy = "http://127.0.0.1:" + str(reject.server_address[1])
        env = {"HOME": str(home), "CFFIXED_USER_HOME": str(home),
               "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy,
               "http_proxy": proxy, "https_proxy": proxy, "all_proxy": proxy,
               "NO_PROXY": "", "no_proxy": ""}
        # Prove that this instance actually uses the isolated proxy before
        # starting its normal mode, which otherwise can download and install.
        exe = bundle / "Contents/MacOS" / info["CFBundleExecutable"]
        checked = subprocess.run([exe, "--check"], env={**os.environ, **env}, capture_output=True, timeout=65)
        if checked.returncode == 0 or not reject.saw_connect.is_set():
            raise RuntimeError("Read-only network preflight did not use the isolated rejecting proxy")
        observe = home / "observe"
        source = Path(__file__).with_suffix(".swift")
        subprocess.run(["xcrun", "swiftc", source, "-o", observe], check=True)

        def instances():
            output = subprocess.check_output([observe, identifier], text=True)
            return json.loads(output)

        if instances():
            raise RuntimeError("A downloader with this bundle identifier is already running")
        active = home / "Library/Application Support/Brclio Downloader Lite/active.json"
        direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def api(method, path):
            url = urlsplit(json.loads(active.read_text()))
            if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or not url.fragment:
                raise ValueError("Unexpected local launcher endpoint")
            request = urllib.request.Request("http://" + url.netloc + path, method=method,
                                             headers={"X-Lite-Key": url.fragment})
            with direct.open(request, timeout=3) as response:
                return response.read()

        def finished():
            apps = instances()
            if len(apps) > 1:
                raise RuntimeError("Multiple LaunchServices instances started")
            if not apps or not active.is_file():
                return False
            app = apps[0]
            if not app["finished"]:
                return False
            if Path(app["bundle"]).resolve() != bundle or not app["regular"]:
                raise RuntimeError("The launched process is not the expected regular Dock application")
            try:
                state = json.loads(api("GET", "/state"))
            except (FileNotFoundError, json.JSONDecodeError, ConnectionRefusedError):
                return False
            except urllib.error.URLError as error:
                if isinstance(error.reason, ConnectionRefusedError):
                    return False
                raise
            if state.get("version") != info["CFBundleShortVersionString"]:
                raise RuntimeError("The served version does not match the opened bundle")
            return app

        launch = ["/usr/bin/open", *[arg for k, v in env.items() for arg in ("--env", f"{k}={v}")], "-a", str(bundle)]
        try:
            subprocess.run(launch, check=True, timeout=35)
            first = wait_for(finished, "AppKit launch-complete and the authenticated local UI")
            original = active.read_bytes()
            receipts = home / "browser-opens"
            if fixture:
                wait_for(receipts.exists, "initial browser callback")
            before = receipts.read_text().splitlines() if fixture else []
            if fixture and len(before) != 1:
                raise RuntimeError("Expected exactly one initial browser open")
            time.sleep(0.75)
            if fixture and receipts.read_text().splitlines() != before:
                raise RuntimeError("The idle fixture reopened its browser without user input")
            if first.get("dockItems") is not None and wait_for(finished, "Dock item").get("dockItems") != 1:
                raise RuntimeError("Expected one Dock entry while running")
            subprocess.run(["/usr/bin/open", "-a", str(bundle)], check=True, timeout=35)
            second = wait_for(finished, "reopened regular Dock application")
            if second["pid"] != first["pid"] or active.read_bytes() != original:
                raise RuntimeError("Reopening changed the downloader PID or its local session")
            if before:
                wait_for(lambda: len(receipts.read_text().splitlines()) > len(before), "browser reopen callback")
                time.sleep(0.4)
                if receipts.read_text().splitlines() != [before[0], before[0]]:
                    raise RuntimeError("Expected one reopen of the original browser session")
            print(f"Verified {identifier} PID {first['pid']}: regular Dock policy, launch finished, local UI ready, "
                  f"reopen reused session. Dock AX items: {first.get('dockItems', 'unavailable')}.")
            wait_for(lambda: not json.loads(api("GET", "/state"))["busy"], "isolated startup to settle", 65)
            subprocess.run([observe, identifier, "--quit", str(first["pid"])], check=True)
            wait_for(lambda: not instances(), "idle downloader to quit after a macOS Quit request")
            print("Verified macOS Quit after operation completion." +
                  (" The fixture recorded exactly one initial browser open and one explicit reopen." if fixture else ""))
        finally:
            for proc in instances():
                if Path(proc["bundle"]).resolve() == bundle:
                    try:
                        os.kill(proc["pid"], signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            reject.shutdown()


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve())
