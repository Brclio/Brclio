package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

//go:embed lite-replace-mac.sh
var liteReplaceMac string

func installLiteUpdate(ctx context.Context, filename, version, digest string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	defaultTarget := filepath.Join(home, "Applications", liteMac.name+".app")
	target := defaultTarget
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if filepath.Base(executable) == liteMac.name && filepath.Base(filepath.Dir(executable)) == "MacOS" {
		current := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
		if !strings.HasPrefix(current, "/Volumes/") && !strings.Contains(current, "/AppTranslocation/") {
			if _, err := inspectMacProduct(ctx, current, liteMac); err != nil {
				return err
			}
			target = current
		}
	}
	parent := filepath.Dir(target)
	if err = os.MkdirAll(parent, 0755); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".brclio-lite-upgrade-")
	if errors.Is(err, os.ErrPermission) && target != defaultTarget {
		target = defaultTarget
		if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		stage, err = os.MkdirTemp(filepath.Dir(target), ".brclio-lite-upgrade-")
	}
	if err != nil {
		return err
	}
	handed := false
	defer func() {
		if !handed {
			_ = os.RemoveAll(stage)
		}
	}()
	next, err := prepareMacApp(ctx, stage, filename, version, digest, liteMac, "Brclio-Downloader-Lite")
	if err != nil {
		return err
	}
	oldID := "-"
	action := "install"
	if _, err = os.Lstat(target); err == nil {
		old, err := inspectMacProduct(ctx, target, liteMac)
		if err != nil {
			return err
		}
		stat := old.file.Sys().(*syscall.Stat_t)
		oldID = fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
		if compareVersion(old.version, version) >= 0 {
			action = "open"
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	script := filepath.Join(stage, "handoff.sh")
	if err = os.WriteFile(script, []byte(liteReplaceMac), 0600); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(stage, "replace.log"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command("/bin/sh", script, strconv.Itoa(os.Getpid()), target, oldID, next, action)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdout, cmd.Stderr = log, log
	if err = cmd.Start(); err != nil {
		return err
	}
	handed = true
	return cmd.Process.Release()
}
