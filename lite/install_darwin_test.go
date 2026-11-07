package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func fixtureBundle(t *testing.T, root string, product macProduct, version, receipt string) string {
	t.Helper()
	bundle := filepath.Join(root, product.name+".app")
	bin := filepath.Join(bundle, "Contents", "MacOS", product.name)
	if err := os.MkdirAll(filepath.Dir(bin), 0755); err != nil {
		t.Fatal(err)
	}
	plist := fmt.Sprintf(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>%s</string><key>CFBundleExecutable</key><string>%s</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>%s</string><key>CFBundleVersion</key><string>%s</string></dict></plist>`, product.id, product.name, version, version)
	if err := os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), []byte(plist), 0644); err != nil {
		t.Fatal(err)
	}
	if receipt == "test-binary" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(exe)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(bin, data, 0755); err != nil {
			t.Fatal(err)
		}
	} else {
		main := fmt.Sprintf("#include <stdio.h>\nint main(void){FILE*f=fopen(%s,\"w\");if(f){fputs(%s,f);fclose(f);}return 0;}\n", strconv.Quote(receipt), strconv.Quote(version))
		file := filepath.Join(t.TempDir(), "main.c")
		if err := os.WriteFile(file, []byte(main), 0644); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("/usr/bin/clang", file, "-o", bin).CombinedOutput(); err != nil {
			t.Fatalf("compile: %s %v", out, err)
		}
	}
	if out, err := exec.Command("/usr/bin/codesign", "--force", "--sign", "-", bundle).CombinedOutput(); err != nil {
		t.Fatalf("sign: %s %v", out, err)
	}
	return bundle
}
func fixtureDMG(t *testing.T, product macProduct, prefix, version, receipt string) (string, string) {
	t.Helper()
	contents := t.TempDir()
	fixtureBundle(t, contents, product, version, receipt)
	suffix, err := platformSuffix()
	if err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(t.TempDir(), prefix+"-"+version+"-"+suffix)
	if out, err := exec.Command("/usr/bin/hdiutil", "create", "-quiet", "-srcfolder", contents, "-format", "UDZO", "-fs", "HFS+", image).CombinedOutput(); err != nil {
		t.Fatalf("create dmg: %s %v", out, err)
	}
	hash, err := fileHash(image)
	if err != nil {
		t.Fatal(err)
	}
	return image, hash
}

func TestMacSystemTargetAndLegacyCopy(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if macBrclioPath != "/Applications/Brclio.app" {
		t.Fatalf("unexpected install target %s", macBrclioPath)
	}
	system := filepath.Join(root, macBrclioPath)
	legacy := fixtureBundle(t, filepath.Join(root, "Users", "test", "Applications"), brclioMac, "9.0.0", filepath.Join(t.TempDir(), "unused"))
	original, err := os.Lstat(legacy)
	if err != nil {
		t.Fatal(err)
	}
	app, err := installedMacBrclio(ctx, system)
	if err != nil || app != nil {
		t.Fatalf("legacy copy masked absent system bundle: %v, %v", app, err)
	}
	fixtureBundle(t, filepath.Dir(system), brclioMac, "1.2.0", filepath.Join(t.TempDir(), "unused"))
	app, err = installedMacBrclio(ctx, system)
	if err != nil || app == nil || app.version != "1.2.0" || app.path != system {
		t.Fatalf("system bundle was not selected: %v, %v", app, err)
	}
	now, err := os.Lstat(legacy)
	if err != nil || !os.SameFile(original, now) {
		t.Fatalf("legacy bundle changed: %v", err)
	}
	link := filepath.Join(t.TempDir(), "Brclio.app")
	if err = os.Symlink(legacy, link); err != nil {
		t.Fatal(err)
	}
	if _, err = installedMacBrclio(ctx, link); err == nil {
		t.Fatal("accepted symlink to a user bundle")
	}
	if err = macTargetError(macBrclioPath, syscall.EROFS); !errors.Is(err, syscall.EROFS) || !strings.Contains(err.Error(), macBrclioPath) {
		t.Fatalf("missing destination permission guidance: %v", err)
	}
}

// Run the same Cocoa guard as the installer against a uniquely identified
// temporary application, never against a real user's Brclio process.
func TestMacRejectsRunningOtherLocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	prod := macProduct{"GuardProbe", "com.brclio.test.runningpath." + strconv.FormatInt(time.Now().UnixNano(), 10)}
	bundle := fixtureBundle(t, t.TempDir(), prod, "1.0.0", filepath.Join(t.TempDir(), "unused"))
	exe := filepath.Join(bundle, "Contents", "MacOS", prod.name)
	sleep, err := os.ReadFile("/bin/sleep")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(exe, sleep, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err = installCommand(ctx, "/usr/bin/codesign", "--force", "--sign", "-", bundle); err != nil {
		t.Fatal(err)
	}
	if _, err = installCommand(ctx, "/usr/bin/open", "-g", "-n", "-a", bundle, "--args", "30"); err != nil {
		t.Fatal(err)
	}
	// Constrain cleanup to both the unique bundle identity and the temporary path,
	// even if registration is delayed or a test assertion fails.
	t.Cleanup(func() {
		const cleanup = `ObjC.import("AppKit"); function run(argv) {
			const target = $.NSURL.fileURLWithPath(argv[1]).URLByResolvingSymlinksInPath.path.js;
			for (const app of $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]).js) {
				if (app.bundleURL.URLByResolvingSymlinksInPath.path.js === target) app.forceTerminate;
			}
		}`
		stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := installCommand(stop, "/usr/bin/osascript", "-l", "JavaScript", "-e", cleanup, prod.id, bundle); err != nil {
			t.Error(err)
		}
	})
	lookup := `ObjC.import("AppKit"); function run(argv) {const apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]).js;return apps.length ? String(apps[0].processIdentifier) : "";}`
	var pid int
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		out, err := installCommand(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", lookup, prod.id)
		if err != nil {
			t.Fatal(err)
		}
		if pid, _ = strconv.Atoi(out); pid > 0 {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if pid <= 0 {
		t.Fatal("test application not registered")
	}
	check := func(target, mode string) error {
		_, err := installCommand(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", runningBrclioScript, prod.id, target, mode)
		return err
	}
	if err = check(bundle, "check"); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"check", "quit"} {
		err = check(filepath.Join(t.TempDir(), "GuardProbe.app"), mode)
		if err == nil || !strings.Contains(err.Error(), "请先退出") {
			t.Fatalf("%s accepted another running copy: %v", mode, err)
		}
		alive, err := installCommand(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", lookup, prod.id)
		if err != nil || alive != strconv.Itoa(pid) {
			t.Fatalf("%s did not preserve the other instance: %s, %v", mode, alive, err)
		}
	}
}

func TestMacInstallFreshAndRollback(t *testing.T) {
	ctx := context.Background()
	version := "1.2.3"
	file, digest := fixtureDMG(t, brclioMac, "Brclio", version, filepath.Join(t.TempDir(), "receipt"))
	for _, rollback := range []bool{false, true} {
		dir := t.TempDir()
		target := filepath.Join(dir, "Brclio.app")
		var old *macBundle
		if rollback {
			fixtureBundle(t, dir, brclioMac, "1.0.0", filepath.Join(t.TempDir(), "receipt"))
			var err error
			old, err = inspectBundle(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
		}
		var launches []string
		err := installMacAt(ctx, file, version, digest, target, old, func(ctx context.Context, path string) error {
			if path != target {
				t.Fatal("unexpected launch target")
			}
			current, err := inspectBundle(ctx, path)
			if err != nil {
				return err
			}
			launches = append(launches, current.version)
			if rollback && current.version == version {
				return errors.New("simulated Launch Services failure")
			}
			return nil
		}, func(context.Context, string) error { return nil })
		if rollback && (err == nil || len(launches) != 2 || launches[1] != "1.0.0") {
			t.Fatalf("rollback: %v %v", err, launches)
		}
		if !rollback && (err != nil || len(launches) != 1 || launches[0] != version) {
			t.Fatalf("install: %v %v", err, launches)
		}
	}
}

func TestLiteMacHandoffHelper(t *testing.T) {
	filename := os.Getenv("BRCLIO_TEST_MAC_UPDATE")
	if filename == "" {
		t.Skip("child process")
	}
	if err := installLiteUpdate(context.Background(), filename, "1.0.1", os.Getenv("BRCLIO_TEST_MAC_DIGEST")); err != nil {
		t.Fatal(err)
	}
}

func TestLiteMacHandoffOpensReplacement(t *testing.T) {
	receipt := filepath.Join(t.TempDir(), "started")
	image, hash := fixtureDMG(t, liteMac, "Brclio-Downloader-Lite", "1.0.1", receipt)
	bundle := fixtureBundle(t, t.TempDir(), liteMac, "1.0.0", "test-binary")
	cmd := exec.Command(filepath.Join(bundle, "Contents", "MacOS", liteMac.name), "-test.run=^TestLiteMacHandoffHelper$")
	cmd.Env = append(os.Environ(), "BRCLIO_TEST_MAC_UPDATE="+image, "BRCLIO_TEST_MAC_DIGEST="+hash)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("handoff: %s %v", out, err)
	}
	for until := time.Now().Add(20 * time.Second); time.Now().Before(until); {
		if data, err := os.ReadFile(receipt); err == nil && string(data) == "1.0.1" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("replacement application did not open")
}

// Set both values to exercise a real release in a temporary Applications folder.
func TestOfficialMacReleaseInstall(t *testing.T) {
	file, digest := os.Getenv("BRCLIO_TEST_OFFICIAL_DMG"), os.Getenv("BRCLIO_TEST_OFFICIAL_SHA")
	if file == "" || digest == "" {
		t.Skip("no official release fixture")
	}
	version := os.Getenv("BRCLIO_TEST_OFFICIAL_VERSION")
	target := filepath.Join(t.TempDir(), "Brclio.app")
	err := installMacAt(context.Background(), file, version, digest, target, nil, func(ctx context.Context, path string) error {
		if path != target {
			return errors.New("unexpected launch target")
		}
		app, err := inspectBundle(ctx, path)
		if err == nil && app.version != version {
			return errors.New("wrong installed version")
		}
		return err
	}, func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
}
