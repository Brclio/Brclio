package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtureRoundTrip func(*http.Request) (*http.Response, error)

func (f fixtureRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLiteResumeAndIntegrity(t *testing.T) {
	for _, scenario := range []string{"206", "200", "badRange", "corrupt", "cache"} {
		t.Run(scenario, func(t *testing.T) {
			file := "Brclio-9.9.9-mac-arm64.dmg"
			data := "abcdefgh"
			expected := fmt.Sprintf("%x", sha256.Sum256([]byte(data)))
			dir := t.TempDir()
			a := installerAsset{version: "9.9.9", name: file, url: downloadBase + "v9.9.9/" + file, checksumURL: downloadBase + "v9.9.9/SHA256SUMS.txt", size: int64(len(data)), digest: expected}
			if err := os.WriteFile(filepath.Join(dir, file+"."+expected+".part"), []byte(data[:3]), 0600); err != nil {
				t.Fatal(err)
			}
			if scenario == "cache" {
				if err := os.WriteFile(filepath.Join(dir, file), []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			client := &http.Client{Transport: fixtureRoundTrip(func(r *http.Request) (*http.Response, error) {
				body := ""
				status := 200
				header := http.Header{}
				switch r.URL.String() {
				case a.checksumURL:
					body = expected + "  " + file + "\n"
				case a.url:
					if scenario == "cache" || r.Header.Get("Range") != "bytes=3-" {
						return nil, errors.New("unexpected asset request")
					}
					if scenario == "200" {
						body = data
					} else {
						status = 206
						body = data[3:]
						header.Set("Content-Range", "bytes 3-7/8")
						if scenario == "badRange" {
							header.Set("Content-Range", "bytes 4-8/9")
						}
						if scenario == "corrupt" {
							body = "XXXXX"
						}
					}
				default:
					return nil, errors.New("unexpected target")
				}
				return &http.Response{StatusCode: status, ContentLength: int64(len(body)), Header: header, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			out, h, err := fetchInstaller(context.Background(), client, dir, a, func(int64, int64) {})
			if scenario == "corrupt" || scenario == "badRange" {
				if err == nil {
					t.Fatal("invalid installer accepted")
				}
				if _, err := os.Stat(filepath.Join(dir, file)); !os.IsNotExist(err) {
					t.Fatal("invalid installer committed")
				}
				return
			}
			if err != nil || h != expected {
				t.Fatal(err, h)
			}
			b, err := os.ReadFile(out)
			if err != nil || string(b) != data {
				t.Fatal(err, string(b))
			}
		})
	}
}
func TestStableFeedAndSelfIsolation(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: fixtureRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != litePointer {
			t.Fatalf("wrong self feed %s", r.URL.Host)
		}
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	a, err := latestLite(context.Background(), client, "mac-arm64.dmg")
	if err != nil || a != nil || calls != 1 {
		t.Fatal(a, err, calls)
	}
	for _, bad := range []string{"", strings.Repeat("0", 64) + "  x\n" + strings.Repeat("0", 64) + "  x\n", "invalid  x"} {
		if _, err := manifestHash([]byte(bad), "x"); err == nil {
			t.Fatal("invalid checksum accepted")
		}
	}
}

func TestInstalledVersionDecidesBeforeInstallerRequests(t *testing.T) {
	const latest = "1.10.0"
	const name = "Brclio-" + latest + "-windows-x64.exe"
	const base = downloadBase + "v" + latest + "/"
	const bytes = "fixture installer bytes"
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(bytes)))
	for _, tc := range []struct {
		current, status string
		shouldOpen      bool
	}{
		{"", "未安装", false},
		{"1.9.9", "升级", false},
		{latest, "已是最新版", true},
		{"2.0.0", "高于正式版", true},
	} {
		t.Run("installed-"+tc.current, func(t *testing.T) {
			ctx := context.Background()
			var calls []string
			client := &http.Client{Transport: fixtureRoundTrip(func(r *http.Request) (*http.Response, error) {
				target := r.URL.String()
				calls = append(calls, target)
				var body string
				switch target {
				case releaseAPI:
					body = fmt.Sprintf(`{"tag_name":"v%s","html_url":"https://github.com/Brclio/Brclio/releases/tag/v%s","draft":false,"prerelease":false,"assets":[{"name":"%s","size":%d,"digest":"sha256:%s","browser_download_url":"%s%s"},{"name":"SHA256SUMS.txt","browser_download_url":"%sSHA256SUMS.txt"}]}`, latest, latest, name, len(bytes), hash, base, name, base)
				case base + "SHA256SUMS.txt":
					body = hash + "  " + name + "\n"
				case base + name:
					body = bytes
				default:
					t.Fatalf("unexpected request %s", target)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, ContentLength: int64(len(body)), Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			asset, err := brclioAsset(ctx, client, "windows-x64.exe")
			if err != nil {
				t.Fatal(err)
			}
			opens := 0
			var status string
			err = useBrclioVersion(tc.current, asset.version, func(s string) { status = s }, func() error { opens++; return nil }, func() error {
				_, _, err := fetchInstaller(ctx, client, t.TempDir(), asset, func(int64, int64) {})
				return err
			})
			if err != nil || !strings.Contains(status, tc.status) {
				t.Fatalf("status %q; %v", status, err)
			}
			expected := []string{releaseAPI}
			if !tc.shouldOpen {
				expected = append(expected, asset.checksumURL, asset.url)
			}
			if strings.Join(calls, "\n") != strings.Join(expected, "\n") || (tc.shouldOpen && opens != 1) || (!tc.shouldOpen && opens != 0) {
				t.Fatalf("requests %v, opens %d", calls, opens)
			}
		})
	}
}
