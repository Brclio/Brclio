package main

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

//go:embed brclio-windows.ps1
var windowsInstallScript string

func runInstallScript(ctx context.Context, action, file, version string) (string, error) {
	powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.CommandContext(ctx, powershell, "-NoProfile", "-NonInteractive", "-Command", windowsInstallScript)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Env = append(os.Environ(), "BRCLIO_LITE_ACTION="+action, "BRCLIO_LITE_FILE="+file, "BRCLIO_LITE_VERSION="+version)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("Windows 安装操作失败: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	return strings.TrimSpace(string(out)), nil
}
func installedVersion(ctx context.Context) (string, error) {
	value, err := runInstallScript(ctx, "version", "", "")
	if err == nil && value != "" && !versionPattern.MatchString(value) {
		return "", fmt.Errorf("Windows 已安装版本无效")
	}
	return value, err
}
func openBrclio(ctx context.Context) error {
	_, err := runInstallScript(ctx, "open", "", "")
	return err
}
func installBrclio(ctx context.Context, filename, version, digest string) error {
	dir, err := os.MkdirTemp("", "brclio-lite-package-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	file, err := stagePackage(filename, dir, "Brclio", version, digest)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	_, err = runInstallScript(context.WithoutCancel(ctx), "install", file, version)
	return err
}
