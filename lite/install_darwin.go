package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

type macBundle struct {
	path    string
	version string
	file    os.FileInfo
}

type macProduct struct{ name, id string }

var brclioMac = macProduct{"Brclio", "com.brclio.toolbox"}
var liteMac = macProduct{"Brclio Downloader Lite", "com.brclio.downloader.lite"}

func inspectBundle(ctx context.Context, path string) (*macBundle, error) {
	return inspectMacProduct(ctx, path, brclioMac)
}
func inspectMacProduct(ctx context.Context, path string, product macProduct) (*macBundle, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("Brclio.app 路径不是应用目录")
	}
	plist, err := installCommand(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", filepath.Join(path, "Contents", "Info.plist"))
	if err != nil {
		return nil, err
	}
	var meta struct{ CFBundleIdentifier, CFBundlePackageType, CFBundleExecutable, CFBundleShortVersionString string }
	if err := json.Unmarshal([]byte(plist), &meta); err != nil {
		return nil, err
	}
	if meta.CFBundleIdentifier != product.id || meta.CFBundlePackageType != "APPL" || meta.CFBundleExecutable != product.name || !versionPattern.MatchString(meta.CFBundleShortVersionString) {
		return nil, errors.New("应用身份不符合 Brclio，已停止安装")
	}
	exe := filepath.Join(path, "Contents", "MacOS", product.name)
	realExe, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return nil, err
	}
	realBundle, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if realExe != filepath.Join(realBundle, "Contents", "MacOS", product.name) {
		return nil, errors.New("应用可执行文件路径无效")
	}
	binary, err := os.Stat(realExe)
	if err != nil || !binary.Mode().IsRegular() {
		return nil, errors.New("Brclio 可执行文件无效")
	}
	return &macBundle{path, meta.CFBundleShortVersionString, info}, nil
}

const macBrclioPath = "/Applications/Brclio.app"

// The user-level bundle created by older downloaders (and any custom copy)
// is a different installation. Only inspect the exact destination we manage.
func installedMacBrclio(ctx context.Context, target string) (*macBundle, error) {
	if _, err := os.Lstat(target); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, macTargetError(target, err)
	}
	return inspectBundle(ctx, target)
}

func installedVersion(ctx context.Context) (string, error) {
	if err := runningMacBrclio(ctx, macBrclioPath, "check"); err != nil {
		return "", err
	}
	app, err := installedMacBrclio(ctx, macBrclioPath)
	if err != nil || app == nil {
		return "", err
	}
	return app.version, nil
}

func openMacBundle(ctx context.Context, path string) error {
	if err := runningMacBrclio(ctx, path, "check"); err != nil {
		return err
	}
	_, err := installCommand(ctx, "/usr/bin/open", "-a", path)
	return err
}

func openBrclio(ctx context.Context) error {
	app, err := installedMacBrclio(ctx, macBrclioPath)
	if err != nil {
		return err
	}
	if app == nil {
		return fmt.Errorf("没有找到 %s", macBrclioPath)
	}
	return openMacBundle(ctx, macBrclioPath)
}

// Darwin renamex_np atomically swaps two nonempty directories. RENAME_EXCL
// protects a fresh installation against a destination that appeared meanwhile.
func moveMacBundle(ctx context.Context, from, to string, swap bool) error {
	const rename = `ObjC.bindFunction("renamex_np", ["int", ["char *","char *","unsigned int"]]); function run(argv) { if ($.renamex_np(argv[0],argv[1],Number(argv[2])) !== 0) throw Error("无法替换目标应用目录"); }`
	flags := "4"
	if swap {
		flags = "2"
	}
	_, err := installCommand(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", rename, from, to, flags)
	return err
}

// Launch Services and Electron can reuse a running copy with the same bundle
// ID. Check every matching process before opening or terminating any of them.
const runningBrclioScript = `ObjC.import("AppKit"); function run(argv) {
	const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]).js;
	const target = $.NSURL.fileURLWithPath(argv[1]).URLByResolvingSymlinksInPath.path.js;
	for (const app of apps) {
		const location = app.bundleURL.URLByResolvingSymlinksInPath.path.js;
		if (location !== target) throw Error("请先退出从 " + location + " 运行的 Brclio，再重试");
	}
	if (argv[2] !== "quit") return;
	apps.forEach(app => app.terminate);
	for(let i=0; i<300 && apps.some(app=>!app.terminated); i++) delay(0.1);
	if(apps.some(app=>!app.terminated)) throw Error("请退出 Brclio 后重试");
}`

func runningMacBrclio(ctx context.Context, target, action string) error {
	_, err := installCommand(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", runningBrclioScript, brclioMac.id, target, action)
	return err
}

func quitTarget(ctx context.Context, target string) error {
	return runningMacBrclio(ctx, target, "quit")
}

func installBrclio(ctx context.Context, filename, version, digest string) error {
	app, err := installedMacBrclio(ctx, macBrclioPath)
	if err != nil {
		return err
	}
	return installMacAt(ctx, filename, version, digest, macBrclioPath, app, openMacBundle, quitTarget)
}

func macTargetError(target string, err error) error {
	if errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EROFS) {
		return fmt.Errorf("无法写入 %s，请让管理员为应用程序目录提供写入权限后重试：%w", target, err)
	}
	return err
}

func installMacAt(ctx context.Context, filename, version, digest, target string, old *macBundle, launch, quit func(context.Context, string) error) error {
	if !versionPattern.MatchString(version) {
		return errors.New("Brclio 版本无效")
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return macTargetError(target, err)
	}
	lock, err := os.Open(parent)
	if err != nil {
		return macTargetError(target, err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("安装目录正被使用，请稍后重试")
	}
	if old != nil && compareVersion(old.version, version) >= 0 {
		return launch(ctx, target)
	}
	stage, err := os.MkdirTemp(parent, ".brclio-lite-")
	if err != nil {
		return macTargetError(target, err)
	}
	preserve := false
	defer func() {
		if !preserve {
			_ = os.RemoveAll(stage)
		}
	}()
	next, err := prepareMacApp(ctx, stage, filename, version, digest, brclioMac, "Brclio")
	if err != nil {
		return err
	}
	if err = quit(ctx, target); err != nil {
		return err
	}
	// After commit begins, finish or restore the installation even if the caller closes the window.
	commit, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if old != nil {
		current, err := inspectBundle(commit, target)
		if err != nil || !os.SameFile(old.file, current.file) || old.version != current.version {
			return errors.New("原 Brclio 安装已改变，请重试")
		}
	}
	if err = moveMacBundle(commit, next, target, old != nil); err != nil {
		return fmt.Errorf("无法替换 %s，请检查应用程序目录的写入权限以及目标是否已被更改：%w", target, err)
	}
	if err = launch(commit, target); err == nil {
		return nil
	}
	if old != nil {
		if rollback := moveMacBundle(commit, next, target, true); rollback != nil {
			preserve = true
			return fmt.Errorf("新版未能打开，旧版保存在 %s: %w", next, rollback)
		}
		_ = launch(commit, target)
	}
	return fmt.Errorf("已安装的 Brclio 未能打开: %w", err)
}

func prepareMacApp(ctx context.Context, stage, filename, version, digest string, product macProduct, prefix string) (next string, err error) {
	installer, err := stagePackage(filename, stage, prefix, version, digest)
	if err != nil {
		return "", err
	}
	mount, err := os.MkdirTemp("", "brclio-image-")
	if err != nil {
		return "", err
	}
	if _, err = installCommand(ctx, "/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, installer); err != nil {
		_ = os.Remove(mount)
		return "", err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		_, detachErr := installCommand(cleanup, "/usr/bin/hdiutil", "detach", mount)
		if detachErr == nil {
			_ = os.Remove(mount)
		} else if err == nil {
			err = detachErr
		}
	}()
	source := filepath.Join(mount, product.name+".app")
	candidate, err := inspectMacProduct(ctx, source, product)
	if err != nil {
		return "", err
	}
	if candidate.version != version {
		return "", errors.New("DMG 内应用的版本与正式版不符")
	}
	next = filepath.Join(stage, "candidate.app")
	if _, err = installCommand(ctx, "/usr/bin/ditto", "--rsrc", "--extattr", "--acl", source, next); err != nil {
		return "", err
	}
	copy, err := inspectMacProduct(ctx, next, product)
	if err != nil {
		return "", err
	}
	if copy.version != version {
		return "", errors.New("暂存的应用版本与正式版不符")
	}
	arch := "arm64"
	if runtime.GOARCH == "amd64" {
		arch = "x86_64"
	}
	if _, err = installCommand(ctx, "/usr/bin/lipo", filepath.Join(next, "Contents", "MacOS", product.name), "-verify_arch", arch); err != nil {
		return "", err
	}
	if _, err = installCommand(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", next); err != nil {
		return "", err
	}
	return next, nil
}
