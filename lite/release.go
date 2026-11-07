package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const releaseAPI = "https://api.github.com/repos/Brclio/Brclio/releases/latest"
const downloadBase = "https://github.com/Brclio/Brclio/releases/download/"
const litePointer = downloadBase + "lite-stable/latest.json"
const downloadLimit = 1536 * 1024 * 1024

var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type installerAsset struct {
	version, name, url, checksumURL, digest string
	size                                    int64
}

func compareVersion(a, b string) int {
	rightParts := strings.Split(b, ".")
	for i, v := range strings.Split(a, ".") {
		left, _ := strconv.Atoi(v)
		right, _ := strconv.Atoi(rightParts[i])
		if left > right {
			return 1
		}
		if left < right {
			return -1
		}
	}
	return 0
}

func platformSuffix() (string, error) {
	switch {
	case runtime.GOOS == "darwin" && runtime.GOARCH == "arm64":
		return "mac-arm64.dmg", nil
	case runtime.GOOS == "darwin" && runtime.GOARCH == "amd64":
		return "mac-x64.dmg", nil
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		return "windows-x64.exe", nil
	default:
		return "", errors.New("当前平台尚无安装包")
	}
}

func readSmall(ctx context.Context, client *http.Client, url string, limit int64, optional bool) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Brclio-Downloader-Lite/"+liteVersion())
	resp, err := client.Do(req)
	if err != nil {
		return nil, safeNetworkFailure("发布服务连接失败，请重试", err)
	}
	defer resp.Body.Close()
	if optional && resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != 200 {
		return nil, responseStatusError("发布服务", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, safeNetworkFailure("发布文件读取失败", err)
	}
	if int64(len(data)) > limit {
		return nil, errors.New("发布文件内容无效或过大")
	}
	return data, nil
}

func brclioAsset(ctx context.Context, client *http.Client, suffix string) (installerAsset, error) {
	b, err := readSmall(ctx, client, releaseAPI, 1<<20, false)
	if err != nil {
		return installerAsset{}, err
	}
	var r struct {
		Tag               string `json:"tag_name"`
		HTML              string `json:"html_url"`
		Draft, Prerelease *bool
		Assets            []struct {
			Name   string
			Size   int64
			Digest string
			URL    string `json:"browser_download_url"`
		}
	}
	if json.Unmarshal(b, &r) != nil || r.Draft == nil || r.Prerelease == nil || *r.Draft || *r.Prerelease ||
		r.HTML != "https://github.com/Brclio/Brclio/releases/tag/"+r.Tag || len(r.Assets) > 128 {
		return installerAsset{}, errors.New("Brclio 正式版信息无效")
	}
	version := strings.TrimPrefix(r.Tag, "v")
	if !versionPattern.MatchString(version) {
		return installerAsset{}, errors.New("Brclio 版本号无效")
	}
	name := "Brclio-" + version + "-" + suffix
	base := downloadBase + r.Tag + "/"
	a := installerAsset{version: version, name: name, url: base + name, checksumURL: base + "SHA256SUMS.txt"}
	files, manifests := 0, 0
	for _, f := range r.Assets {
		switch f.Name {
		case name:
			if f.URL != a.url || f.Size < 1 || f.Size > downloadLimit {
				return a, errors.New("官方安装包地址或大小无效")
			}
			if f.Digest != "" {
				a.digest = strings.TrimPrefix(f.Digest, "sha256:")
				if f.Digest != "sha256:"+a.digest || !hashPattern.MatchString(a.digest) {
					return a, errors.New("官方安装包摘要无效")
				}
			}
			a.size = f.Size
			files++
		case "SHA256SUMS.txt":
			if f.URL != a.checksumURL {
				return a, errors.New("校验清单地址无效")
			}
			manifests++
		}
	}
	if files != 1 || manifests != 1 {
		return a, errors.New("该版本缺少当前平台唯一的安装包或校验清单")
	}
	return a, nil
}

func latestLite(ctx context.Context, client *http.Client, suffix string) (*installerAsset, error) {
	b, err := readSmall(ctx, client, litePointer, 8192, true)
	if err != nil || b == nil {
		return nil, err
	}
	var r struct {
		Version string
		Assets  []struct {
			Name, SHA256 string
			Size         int64
		}
	}
	if json.Unmarshal(b, &r) != nil || !versionPattern.MatchString(r.Version) {
		return nil, errors.New("便捷版发布索引无效")
	}
	if compareVersion(r.Version, liteVersion()) <= 0 {
		return nil, nil
	}
	name := "Brclio-Downloader-Lite-" + r.Version + "-" + suffix
	base := downloadBase + "lite-v" + r.Version + "/"
	var match *installerAsset
	for _, f := range r.Assets {
		if f.Name == name {
			if match != nil || !hashPattern.MatchString(f.SHA256) || f.Size < 1 || f.Size > downloadLimit {
				return nil, errors.New("便捷版安装包信息无效")
			}
			match = &installerAsset{version: r.Version, name: name, url: base + name, digest: f.SHA256, size: f.Size, checksumURL: base + "SHA256SUMS.txt"}
		}
	}
	if match == nil {
		return nil, errors.New("此平台的便捷版尚未发布")
	}
	return match, nil
}

func manifestHash(text []byte, name string) (string, error) {
	found := ""
	scanner := bufio.NewScanner(strings.NewReader(string(text)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			if found != "" || !hashPattern.MatchString(fields[0]) {
				return "", errors.New("安装包校验值无效或重复")
			}
			found = fields[0]
		}
	}
	if found == "" || scanner.Err() != nil {
		return "", errors.New("找不到安装包的 SHA-256 校验值")
	}
	return found, nil
}

func fileHash(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// The SHA in the partial filename binds resumed bytes to this exact package.
func fetchInstaller(ctx context.Context, client *http.Client, dir string, a installerAsset, progress func(int64, int64)) (string, string, error) {
	b, err := readSmall(ctx, client, a.checksumURL, 128*1024, false)
	if err != nil {
		return "", "", err
	}
	expected, err := manifestHash(b, a.name)
	if err != nil {
		return "", "", err
	}
	if a.digest != "" && a.digest != expected {
		return "", "", errors.New("安装包摘要与官方校验清单不一致")
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", "", err
	}
	final := filepath.Join(dir, a.name)
	part := final + "." + expected + ".part"
	if st, e := os.Lstat(final); e == nil {
		if !st.Mode().IsRegular() {
			return "", "", errors.New("安装包缓存路径无效")
		}
		if st.Size() == a.size {
			if digest, e := fileHash(final); e == nil && digest == expected {
				return final, expected, nil
			}
		}
		if err = os.Remove(final); err != nil {
			return "", "", err
		}
	} else if !os.IsNotExist(e) {
		return "", "", e
	}
	offset := int64(0)
	if st, e := os.Lstat(part); e == nil {
		if !st.Mode().IsRegular() {
			return "", "", errors.New("续传缓存路径无效")
		}
		offset = st.Size()
		if offset > a.size {
			if err = os.Remove(part); err != nil {
				return "", "", err
			}
			offset = 0
		}
	} else if !os.IsNotExist(e) {
		return "", "", e
	}
	if offset < a.size {
		bodyCtx, cancel := context.WithCancelCause(ctx)
		defer cancel(nil)
		req, err := http.NewRequestWithContext(bodyCtx, "GET", a.url, nil)
		if err != nil {
			return "", "", err
		}
		req.Header.Set("User-Agent", "Brclio-Downloader-Lite/"+liteVersion())
		req.Header.Set("Accept-Encoding", "identity")
		if offset > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		}
		idle := transientNetworkError("安装包传输超时")
		timer := time.AfterFunc(60*time.Second, func() { cancel(idle) })
		defer timer.Stop()
		resp, err := client.Do(req)
		if err != nil {
			if context.Cause(bodyCtx) == idle {
				return "", "", idle
			}
			return "", "", safeNetworkFailure("安装包连接失败，可重试续传", err)
		}
		defer resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusOK:
			offset = 0
		case http.StatusPartialContent:
			if offset == 0 || resp.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", offset, a.size-1, a.size) {
				return "", "", errors.New("服务器返回无效的续传范围")
			}
		default:
			return "", "", responseStatusError("安装包服务", resp.StatusCode)
		}
		if enc := resp.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
			return "", "", errors.New("安装包传输编码无效")
		}
		if resp.ContentLength >= 0 && resp.ContentLength != a.size-offset {
			return "", "", errors.New("安装包长度不符")
		}
		flags := os.O_CREATE | os.O_WRONLY
		if offset == 0 {
			flags |= os.O_TRUNC
		} else {
			flags |= os.O_APPEND
		}
		f, err := os.OpenFile(part, flags, 0600)
		if err != nil {
			return "", "", err
		}
		n := offset
		progress(n, a.size)
		buffer := make([]byte, 64*1024)
		for {
			read, readErr := resp.Body.Read(buffer)
			if n+int64(read) > a.size {
				f.Close()
				os.Remove(part)
				return "", "", errors.New("安装包超过发布大小")
			}
			if read > 0 {
				if _, err = f.Write(buffer[:read]); err != nil {
					f.Close()
					return "", "", err
				}
				n += int64(read)
				timer.Reset(60 * time.Second)
				progress(n, a.size)
			}
			if readErr != nil {
				if readErr != io.EOF || n != a.size {
					if closeErr := f.Close(); closeErr != nil {
						return "", "", closeErr
					}
					if context.Cause(bodyCtx) == idle {
						return "", "", idle
					}
					return "", "", safeNetworkFailure("下载中断，重试将继续下载", readErr)
				}
				break
			}
		}
		if err = f.Close(); err != nil {
			return "", "", err
		}
	}
	digest, err := fileHash(part)
	if err != nil {
		return "", "", err
	}
	if digest != expected {
		os.Remove(part)
		return "", "", errors.New("完整文件 SHA-256 校验失败")
	}
	if err = os.Rename(part, final); err != nil {
		return "", "", err
	}
	return final, expected, nil
}

// Only transport operations enter this loop. Integrity failures, OS installation
// errors and rate limits never trigger another request or installer handoff.
func retryTransfer(ctx context.Context, report func(string), attempt func() error) error {
	for i := 0; ; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := attempt()
		var transient transientNetworkError
		if !errors.As(err, &transient) || i >= 2 {
			return err
		}
		report(fmt.Sprintf("连接中断，重新选择下载线路（%d/2）", i+1))
		timer := time.NewTimer(time.Duration(i+1) * 500 * time.Millisecond)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}
	}
}

func withFreshRoute(ctx context.Context, target string, report func(string), run func(*http.Client) error) error {
	return retryTransfer(ctx, report, func() error {
		client, closeRoute, err := selectNetwork(ctx, target, report)
		if err != nil {
			return err
		}
		defer closeRoute()
		return run(client)
	})
}

func downloadOnCurrentRoute(ctx context.Context, dir string, a installerAsset, report func(string), progress func(int64, int64)) (string, string, error) {
	var file, digest string
	err := withFreshRoute(ctx, a.url, report, func(client *http.Client) error {
		report("下载并校验 " + a.name)
		var err error
		file, digest, err = fetchInstaller(ctx, client, dir, a, progress)
		return err
	})
	return file, digest, err
}

// Each invocation selects its own current route. The two release channels
// have independent versions and verified installer identities.
func runLite(ctx context.Context, action, dir string, report func(string), progress func(int64, int64)) (bool, error) {
	suffix, err := platformSuffix()
	if err != nil {
		return false, err
	}
	if action == "self" || action == "startup" {
		selfErr := func() error {
			var a *installerAsset
			err := withFreshRoute(ctx, litePointer, report, func(c *http.Client) error {
				var err error
				a, err = latestLite(ctx, c, suffix)
				return err
			})
			if err != nil {
				return err
			}
			if a == nil {
				if action == "self" {
					report("当前没有更新的便捷版")
				}
				return nil
			}
			report("正在下载便捷版 " + a.version)
			f, h, err := downloadOnCurrentRoute(ctx, dir, *a, report, progress)
			if err != nil {
				return err
			}
			report("正在安装并重新打开便捷版")
			if err = installLiteUpdate(ctx, f, a.version, h); err != nil {
				return err
			}
			_ = os.Remove(f)
			return errRestart
		}()
		if selfErr == errRestart {
			return true, nil
		}
		if action == "self" {
			return false, selfErr
		}
		if selfErr != nil {
			report("便捷版更新暂不可用，继续检查 Brclio")
		}
	}
	report("检查 Brclio 最新稳定版")
	var a installerAsset
	err = withFreshRoute(ctx, releaseAPI, report, func(c *http.Client) error {
		var err error
		a, err = brclioAsset(ctx, c, suffix)
		return err
	})
	if err != nil {
		return false, err
	}
	if action == "check" {
		report("Brclio 最新稳定版 " + a.version)
		return false, nil
	}
	current, err := installedVersion(ctx)
	if err != nil {
		return false, err
	}
	if current != "" {
		if !versionPattern.MatchString(current) {
			return false, errors.New("已安装 Brclio 的版本号无效")
		}
		if compareVersion(current, a.version) >= 0 {
			if err = openBrclio(ctx); err != nil {
				return false, err
			}
			report("已打开 Brclio " + current)
			return false, nil
		}
	}
	report("下载 Brclio " + a.version)
	f, h, err := downloadOnCurrentRoute(ctx, dir, a, report, progress)
	if err != nil {
		return false, err
	}
	report("正在安装并打开 Brclio " + a.version)
	if err = installBrclio(ctx, f, a.version, h); err != nil {
		return false, err
	}
	_ = os.Remove(f)
	report("已安装并打开 Brclio " + a.version)
	return false, nil
}

var errRestart = errors.New("restart lite")
