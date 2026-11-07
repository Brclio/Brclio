package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in only: the shell's release gate provisions an empty disposable runner.
func TestCanonicalApplicationsOnMacRunner(t *testing.T) {
	work := os.Getenv("BRCLIO_CANONICAL_SMOKE_DIR")
	if work == "" {
		t.Skip("disposable macOS release gate")
	}
	temp, err := filepath.EvalSymlinks(os.Getenv("RUNNER_TEMP"))
	if err != nil || os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("RUNNER_OS") != "macOS" ||
		os.Getenv("RUNNER_ENVIRONMENT") != "github-hosted" || filepath.Dir(work) != temp ||
		!strings.HasPrefix(filepath.Base(work), "brclio-canonical-") || os.Getenv("HOME") != filepath.Join(work, "home") {
		t.Fatal("refusing canonical installation outside the disposable release gate")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	phase := os.Getenv("BRCLIO_CANONICAL_PHASE")
	current, err := installedVersion(ctx)
	if phase == "blocked" {
		legacy := filepath.Join(os.Getenv("HOME"), "Applications", "Brclio.app")
		if err == nil || !strings.Contains(err.Error(), legacy) {
			t.Fatalf("running legacy instance must block: %q %v", current, err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	version := os.Getenv("BRCLIO_TEST_OFFICIAL_VERSION")
	if (phase == "fresh" && current != "") || (phase == "current" && current != version) ||
		(phase != "fresh" && phase != "current") {
		t.Fatalf("unexpected phase %s or installed version %s", phase, current)
	}
	var opens, installs int
	err = useBrclioVersion(current, version, func(s string) { t.Log(s) }, func() error {
		opens++
		if phase != "current" {
			return errors.New("fresh install tried to open legacy app")
		}
		return openBrclio(ctx)
	}, func() error {
		installs++
		if phase != "fresh" {
			return errors.New("current install attempted another download")
		}
		return installBrclio(ctx, os.Getenv("BRCLIO_TEST_OFFICIAL_DMG"), version, os.Getenv("BRCLIO_TEST_OFFICIAL_SHA"))
	})
	if err != nil || (phase == "fresh" && (installs != 1 || opens != 0)) || (phase == "current" && (opens != 1 || installs != 0)) {
		t.Fatalf("%s, open=%d install=%d: %v", phase, opens, installs, err)
	}
}
