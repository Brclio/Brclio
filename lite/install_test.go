package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerRejectsWrongDigestAndProduct(t *testing.T) {
	suffix, err := platformSuffix()
	if err != nil {
		t.Skip(err)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "Brclio-1.2.3-"+suffix)
	if err = os.WriteFile(file, []byte("broken installer"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, prefix := range []string{"Brclio", "Brclio-Downloader-Lite"} {
		_, err = stagePackage(file, t.TempDir(), prefix, "1.2.3", strings.Repeat("0", 64))
		if err == nil {
			t.Fatalf("%s accepted invalid package", prefix)
		}
	}
}
