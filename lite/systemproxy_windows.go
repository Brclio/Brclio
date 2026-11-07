package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func platformProxy(ctx context.Context, target string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	path := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.CommandContext(ctx, path, "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $u=[Uri]$env:BRCLIO_LITE_TARGET; $p=[Net.WebRequest]::GetSystemWebProxy(); if (-not $p.IsBypassed($u)) { $v=$p.GetProxy($u); if ($v -ne $u) { [Console]::Write($v.AbsoluteUri) } }`)
	cmd.Env = append(os.Environ(), "BRCLIO_LITE_TARGET="+target)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	b, err := cmd.Output()
	return strings.TrimSpace(string(b)), err
}
