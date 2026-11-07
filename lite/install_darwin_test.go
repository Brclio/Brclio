package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
