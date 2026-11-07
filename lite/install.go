package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Keep the exact bytes passed to the OS installer in our private staging directory.
func stagePackage(source, directory, prefix, version, digest string) (string, error) {
	suffix, err := platformSuffix()
	if err != nil {
		return "", err
	}
	name := prefix + "-" + version + "-" + suffix
	if !versionPattern.MatchString(version) || filepath.Base(source) != name {
		return "", errors.New("安装包名称、版本或架构不符")
	}
	expected, err := hex.DecodeString(digest)
	if err != nil || len(expected) != sha256.Size {
		return "", errors.New("安装包 SHA-256 无效")
	}
	info, err := os.Lstat(source)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("安装包必须是普通文件")
	}
	in, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer in.Close()
	opened, err := in.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return "", errors.New("安装包已改变")
	}
	target := filepath.Join(directory, name)
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(out, hash), in)
	closeErr := out.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n == 0 || n != info.Size() || hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(digest) {
		return "", errors.New("安装包 SHA-256 校验失败")
	}
	return target, nil
}

func installCommand(ctx context.Context, command string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s: %w (%s)", filepath.Base(command), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
