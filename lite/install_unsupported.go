//go:build !darwin && !windows

package main

import (
	"context"
	"errors"
)

var unsupportedInstall = errors.New("此平台不支持 Brclio 安装")

func installedVersion(context.Context) (string, error)                { return "", unsupportedInstall }
func openBrclio(context.Context) error                                { return unsupportedInstall }
func installBrclio(context.Context, string, string, string) error     { return unsupportedInstall }
func installLiteUpdate(context.Context, string, string, string) error { return unsupportedInstall }
