package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These tests install programs and open windows. Run only on a disposable CI host.
func requireWindowsReleaseRunner(t *testing.T) {
	t.Helper()
	if os.Getenv("BRCLIO_LITE_WINDOWS_SMOKE") != "1" {
		t.Skip("native Windows release gate")
	}
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("RUNNER_OS") != "Windows" {
		t.Fatal("native installation gate requires the Windows Actions runner")
	}
}

func smokePowerShell(t *testing.T, script string, vars ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.CommandContext(ctx, ps, "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; "+script)
	cmd.Env = append(os.Environ(), vars...)
	b, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Windows process check failed: %v: %s", err, b)
	}
	return strings.TrimSpace(string(b))
}

func TestWindowsPublicBrclioInstallAndUpgrade(t *testing.T) {
	requireWindowsReleaseRunner(t)
	ctx := context.Background()
	old, err := installedVersion(ctx)
	if err != nil || old != "" {
		t.Fatalf("expected a clean runner, found Brclio %q: %v", old, err)
	}
	latest := os.Getenv("BRCLIO_LITE_TEST_LATEST")
	if !versionPattern.MatchString(latest) || compareVersion(latest, "0.2.7") <= 0 {
		t.Fatal("latest stable version must be newer than the upgrade fixture")
	}
	for _, version := range []string{"0.2.7", latest} {
		dir := filepath.Join(os.Getenv("BRCLIO_LITE_TEST_RELEASES"), version)
		name := "Brclio-" + version + "-windows-x64.exe"
		manifest, err := os.ReadFile(filepath.Join(dir, "SHA256SUMS.txt"))
		if err != nil {
			t.Fatal(err)
		}
		digest, err := manifestHash(manifest, name)
		if err != nil {
			t.Fatal(err)
		}
		if err = installBrclio(ctx, filepath.Join(dir, name), version, digest); err != nil {
			t.Fatalf("installing Brclio %s: %v", version, err)
		}
		if installed, err := installedVersion(ctx); err != nil || installed != version {
			t.Fatalf("installed Brclio %q, expected %s: %v", installed, version, err)
		}
		// Wait for the actual main window before testing the next native update.
		pid := smokePowerShell(t, `
$folder=(Get-ItemProperty -LiteralPath 'HKCU:\Software\c8f079c5-a346-5aee-a72f-5280717e7b26').InstallLocation
$exe=Join-Path $folder 'Brclio.exe'
$until=[DateTime]::UtcNow.AddSeconds(45)
do {
  $p=Get-Process -Name Brclio -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { Write-Output $p.Id; return }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $until)
throw 'Expected installed Brclio executable to open its main window.'`)
		t.Logf("verified official Brclio %s registered and opened main window in PID %s", version, pid)
	}
}

// Build a known older launcher that invokes the production handoff. The candidate
// is the exact Windows executable this workflow is about to publish.
func TestWindowsPortableSelfHandoff(t *testing.T) {
	requireWindowsReleaseRunner(t)
	packaged := os.Getenv("BRCLIO_LITE_TEST_EXE")
	digest, err := fileHash(packaged)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	mainFile, err := filepath.Abs("main.go")
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(mainFile)
	if err != nil {
		t.Fatal(err)
	}
	mainCode := strings.Replace(string(b), "func main() {", "func inactiveDownloadUI() {", 1)
	if mainCode == string(b) {
		t.Fatal("could not prepare old-launcher fixture")
	}
	mainCode += `
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" { fmt.Println("0.0.0"); return }
	if err := installLiteUpdate(context.Background(), os.Getenv("BRCLIO_LITE_TEST_EXE"), liteVersion(), os.Getenv("BRCLIO_LITE_TEST_SHA")); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
}`
	replacement := filepath.Join(dir, "fixture.go")
	if err := os.WriteFile(replacement, []byte(mainCode), 0600); err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(dir, "overlay.json")
	overlayJSON, err := json.Marshal(map[string]any{"Replace": map[string]string{mainFile: replacement}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(overlay, overlayJSON, 0600); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "Portable Launcher.exe")
	cmd := exec.Command("go", "build", "-buildvcs=false", "-overlay", overlay, "-o", old, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building old fixture: %v: %s", err, out)
	}
	if out, err := exec.Command(old, "--version").CombinedOutput(); err != nil || strings.TrimSpace(string(out)) != "0.0.0" {
		t.Fatalf("old fixture version: %s, %v", out, err)
	}
	profile := filepath.Join(dir, "Profile")
	active := filepath.Join(profile, "Brclio Downloader Lite", "active.json")
	if err = os.MkdirAll(filepath.Dir(active), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(filepath.Dir(active), "skip-self-update"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command(old)
	// Prevent the launched candidate from navigating to a real installer or subscription.
	cmd.Env = append(os.Environ(), "BRCLIO_LITE_TEST_SHA="+digest, "APPDATA="+profile, "HTTPS_PROXY=http://127.0.0.1:1", "NO_PROXY=localhost,127.0.0.1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("old launcher handoff: %v: %s", err, out)
	}
	t.Cleanup(func() {
		smokePowerShell(t, `Get-Process -Name 'Portable Launcher' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $env:BRCLIO_LITE_TEST_TARGET } | Stop-Process -Force; Start-Sleep -Milliseconds 500`, "BRCLIO_LITE_TEST_TARGET="+old)
	})
	until := time.Now().Add(60 * time.Second)
	client := http.Client{Timeout: time.Second}
	for time.Now().Before(until) {
		b, err := os.ReadFile(active)
		var link string
		if err == nil && json.Unmarshal(b, &link) == nil {
			u, err := url.Parse(link)
			if err != nil || u.Hostname() != "127.0.0.1" || u.Scheme != "http" || u.Fragment == "" {
				t.Fatal("invalid local launcher address")
			}
			key := u.Fragment
			u.Fragment = ""
			u.Path = "/state"
			req, _ := http.NewRequest("GET", u.String(), nil)
			req.Header.Set("X-Lite-Key", key)
			if resp, err := client.Do(req); err == nil {
				body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
				resp.Body.Close()
				var s view
				if err == nil && resp.StatusCode == 200 && json.Unmarshal(body, &s) == nil && s.Version == liteVersion() {
					hash, err := fileHash(old)
					if err != nil || hash != digest {
						t.Fatal("replacement differs from the packaged Windows binary", err)
					}
					pid := smokePowerShell(t, `$p=Get-Process -Name 'Portable Launcher' -ErrorAction Stop | Where-Object { $_.Path -ieq $env:BRCLIO_LITE_TEST_TARGET } | Select-Object -First 1; if (!$p) { throw 'Expected new portable executable.' }; Write-Output $p.Id`, "BRCLIO_LITE_TEST_TARGET="+old)
					t.Logf("verified packaged lite %s replaced the fixture and served its UI in PID %s", s.Version, pid)
					return
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	logs, _ := filepath.Glob(filepath.Join(dir, ".brclio-lite-upgrade-*", "error.log"))
	for _, log := range logs {
		b, _ := os.ReadFile(log)
		t.Logf("helper: %s", b)
	}
	t.Fatal("replacement did not open its authenticated local UI")
}
