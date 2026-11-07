package main

import (
	"context"
	"debug/buildinfo"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed lite-replace-win.ps1
var liteReplaceWindows string

func isLiteExecutable(filename string) bool {
	info, err := buildinfo.ReadFile(filename)
	return err == nil && info.Path == "brclio/lite" && info.Main.Path == "brclio/lite"
}

func installLiteUpdate(ctx context.Context, filename, version, digest string) error {
	current, err := os.Executable()
	if err != nil {
		return err
	}
	current, err = filepath.Abs(current)
	if err != nil {
		return err
	}
	target := current
	var stage string
	if isLiteExecutable(current) && !strings.Contains(strings.ToLower(current), `\go-build`) {
		stage, err = os.MkdirTemp(filepath.Dir(target), ".brclio-lite-upgrade-")
		if err != nil && !errors.Is(err, os.ErrPermission) {
			return err
		}
	}
	replaceCurrent := stage != ""
	if stage == "" {
		base := os.Getenv("LOCALAPPDATA")
		if !filepath.IsAbs(base) {
			return errors.New("未找到用户程序目录")
		}
		dir := filepath.Join(base, "Brclio Downloader Lite")
		if err = os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if !versionPattern.MatchString(version) {
			return errors.New("下载器版本无效")
		}
		target = filepath.Join(dir, "Brclio-Downloader-Lite-"+version+"-windows-x64.exe")
		stage, err = os.MkdirTemp(dir, ".brclio-lite-upgrade-")
		if err != nil {
			return err
		}
	}
	handed := false
	defer func() {
		if !handed {
			_ = os.RemoveAll(stage)
		}
	}()
	candidate, err := stagePackage(filename, stage, "Brclio-Downloader-Lite", version, digest)
	if err != nil {
		return err
	}
	if !isLiteExecutable(candidate) {
		return errors.New("下载器程序身份无效")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	script := filepath.Join(stage, "replace.ps1")
	if err = os.WriteFile(script, []byte(liteReplaceWindows), 0600); err != nil {
		return err
	}
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.Command(ps, "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script)
	cmd.Env = append(os.Environ(), "BRCLIO_LITE_PARENT="+strconv.Itoa(os.Getpid()), "BRCLIO_LITE_SOURCE="+candidate, "BRCLIO_LITE_TARGET="+target,
		"BRCLIO_LITE_REPLACE="+strconv.FormatBool(replaceCurrent), "BRCLIO_LITE_SHA="+digest)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	if err = cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timeout := time.NewTimer(15 * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(filepath.Join(stage, "ready")); err == nil {
				handed = true
				return nil
			}
		case err := <-done:
			return fmt.Errorf("升级助手退出: %v", err)
		case <-timeout.C:
			_ = cmd.Process.Kill()
			return errors.New("升级助手启动超时")
		}
	}
}
