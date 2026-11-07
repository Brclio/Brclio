package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRelayValidation(t *testing.T) {
	node := relayNode{UUID: "12345678-1234-1234-1234-123456789abc", Host: "relay.example.org", ServerName: "relay.example.org", WSHost: "relay.example.org", DialAddress: "1.1.1.1", Port: 443, Path: "/tunnel?v=1"}
	if !node.valid() {
		t.Fatal("valid relay rejected")
	}
	for _, addr := range []string{"127.0.0.1", "100.64.0.1", "169.254.1.42", "192.168.1.1", "198.18.0.2", "203.0.113.7", "240.0.0.1", "fe80::1", "localhost", "secret.internal"} {
		n := node
		n.DialAddress = addr
		if n.valid() {
			t.Errorf("accepted private/reserved address %s", addr)
		}
	}
	for _, path := range []string{"//other.example", "/a\\b", "/space here", "/bad%gg", "/bad#fragment"} {
		n := node
		n.Path = path
		if n.valid() {
			t.Errorf("accepted invalid node path %q", path)
		}
	}
	if !publicIPv4(netip.MustParseAddr("1.1.1.1")) {
		t.Fatal("public IPv4 excluded")
	}
	n := node
	n.ServerName = "other.example.org"
	if n.valid() {
		t.Fatal("mismatched certificate hostname accepted")
	}
	b, _ := json.Marshal(map[string]any{"version": 1, "ttlSeconds": 600, "nodes": []relayNode{node}})
	if _, err := parseRelayNodes(b); err != nil {
		t.Fatal(err)
	}
	if _, err := parseRelayNodes(append(b, []byte("{}")...)); err == nil {
		t.Fatal("trailing document accepted")
	}
	if _, err := parseRelayNodes([]byte(strings.Replace(string(b), `"port":443`, `"port":443,"insecure":true`, 1))); err == nil {
		t.Fatal("unknown TLS setting accepted")
	}
}
func TestRelayResponseHeader(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	go func() {
		defer b.Close()
		for _, s := range [][]byte{{0}, {3, 9}, {8}, {7}, []byte("TLS")} {
			if _, err := b.Write(s); err != nil {
				return
			}
		}
	}()
	c := &vlessConn{Conn: a}
	result, err := io.ReadAll(c)
	if err != nil || string(result) != "TLS" {
		t.Fatalf("bad response header: %q %v", result, err)
	}
}
func TestUntrustedNetworkDestinations(t *testing.T) {
	for _, text := range []string{"http://github.com/x", "https://github.com:8443/x", "https://localhost/x", "https://github.com.evil.org/x", "https://user@github.com/x", "https://github.com/x#fragment"} {
		u, _ := url.Parse(text)
		if githubURL(u) {
			t.Errorf("accepted %q", text)
		}
	}
}
func TestSubscriptionRejectsRedirectAndLimits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "http://127.0.0.1/private", 302)
		case "/oversize":
			fmt.Fprint(w, strings.Repeat("a", 32769))
		case "/limited":
			w.WriteHeader(429)
		case "/challenge":
			w.Header().Set("cf-mitigated", "challenge")
			w.WriteHeader(403)
		}
	}))
	defer server.Close()
	client := &http.Client{CheckRedirect: noNetworkRedirect}
	for _, path := range []string{"/redirect", "/oversize", "/limited", "/challenge"} {
		_, alias, err := fetchSubscription(context.Background(), client, server.URL+path)
		if err == nil || alias != (path == "/challenge") {
			t.Errorf("unexpected fallback for %s", path)
		}
	}
}

func TestLiveBuiltinRange(t *testing.T) {
	if os.Getenv("BRCLIO_LITE_LIVE") != "1" {
		t.Skip("live production probe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	direct := networkTransport()
	defer direct.CloseIdleConnections()
	meta := &http.Client{Transport: direct, CheckRedirect: noNetworkRedirect}
	nodes, alias, err := fetchSubscription(ctx, meta, subscriptionURL)
	if err != nil && alias {
		nodes, _, err = fetchSubscription(ctx, meta, subscriptionAlias)
	}
	if err != nil {
		t.Fatal(err)
	}
	tr, latency, err := fastestRelay(ctx, nodes)
	if err != nil {
		t.Fatal(err)
	}
	defer tr.CloseIdleConnections()
	t.Logf("selected route: %d ms", latency.Milliseconds())
	client := &http.Client{Transport: &githubTransport{route: tr, metadata: meta, ctx: ctx}}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://github.com/Brclio/Brclio/releases/download/v0.2.8/Brclio-0.2.8-mac-arm64.dmg", nil)
	req.Header.Set("Range", "bytes=0-1023")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal("production range failed")
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1025))
	if err != nil || res.StatusCode != 206 || len(body) != 1024 || !strings.HasPrefix(res.Header.Get("Content-Range"), "bytes 0-1023/") {
		t.Fatalf("invalid range HTTP %d (%d bytes)", res.StatusCode, len(body))
	}
	t.Log("verified official package", res.Header.Get("Content-Range"))
}

type testRoundTrip func(*http.Request) (*http.Response, error)

func (f testRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestMetadataFallbackOnlyOnExplicitAPIRateLimit(t *testing.T) {
	for _, tc := range []struct {
		target    string
		status    int
		remaining string
		fallback  bool
	}{
		{gitHubLatest, 429, "", true}, {gitHubLatest, 403, "0", true}, {gitHubLatest, 403, "1", false},
		{"https://github.com/Brclio/Brclio/releases/download/v1.2.3/SHA256SUMS.txt", 429, "", false},
	} {
		hits := 0
		g := githubTransport{ctx: context.Background(), route: testRoundTrip(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: tc.status, Header: http.Header{"X-Ratelimit-Remaining": []string{tc.remaining}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		}), metadata: &http.Client{Transport: testRoundTrip(func(req *http.Request) (*http.Response, error) {
			hits++
			if req.URL.Host != "tools.brclio.com" || req.URL.Path != "/api/update" || req.URL.Query().Get("url") != gitHubLatest {
				t.Fatal("unexpected metadata destination")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v1.2.3","html_url":"https://github.com/Brclio/Brclio/releases/tag/v1.2.3","draft":false,"prerelease":false,"assets":[{}]}`))}, nil
		}), CheckRedirect: noNetworkRedirect}}
		req, _ := http.NewRequest("GET", tc.target, nil)
		res, err := g.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if (hits > 0) != tc.fallback || (res.StatusCode == 200) != tc.fallback {
			t.Fatal("unexpected fallback", tc)
		}
	}
}

func TestClosingActionCancelsSystemRequest(t *testing.T) {
	action, closeRoute := context.WithCancel(context.Background())
	began := make(chan struct{})
	g := githubTransport{ctx: action, route: testRoundTrip(func(req *http.Request) (*http.Response, error) {
		close(began)
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	req, _ := http.NewRequest("GET", gitHubLatest, nil)
	done := make(chan error, 1)
	go func() { _, err := g.RoundTrip(req); done <- err }()
	<-began
	closeRoute()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatal("unexpected cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("system proxy ignored operation cancellation")
	}
}

// Set BRCLIO_LITE_LIVE_FULL=1 on a host without a system proxy to exercise
// actual production metadata, TLS, installer resume and whole-file verification.
type interruptedDownload struct {
	io.Reader
	io.Closer
}

func TestLiveBuiltinFull(t *testing.T) {
	if os.Getenv("BRCLIO_LITE_LIVE_FULL") != "1" {
		t.Skip("live full installer download")
	}
	ctx := context.Background()
	dir := t.TempDir()
	builtin := false
	report := func(message string) {
		t.Log(message)
		if strings.HasPrefix(message, "内置代理") {
			builtin = true
		}
	}
	var a installerAsset
	err := withFreshRoute(ctx, releaseAPI, report, func(client *http.Client) error {
		var err error
		a, err = brclioAsset(ctx, client, "mac-arm64.dmg")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if !builtin {
		t.Fatal("this test requires no system proxy")
	}
	interrupted, resumed := false, false
	var filename, digest string
	last := int64(-1)
	download := func(client *http.Client) error {
		routed := client.Transport
		client.Transport = testRoundTrip(func(req *http.Request) (*http.Response, error) {
			res, err := routed.RoundTrip(req)
			if err != nil {
				return nil, err
			}
			if req.Header.Get("Range") != "" && res.StatusCode == 206 {
				resumed = true
				t.Log("resume confirmed", req.Header.Get("Range"), res.Header.Get("Content-Range"))
			}
			// Preserve the advertised original length, then simulate a dropped
			// transfer after receiving a real 1 MiB prefix from the GitHub CDN.
			if !interrupted && req.URL.Host == "release-assets.githubusercontent.com" && res.StatusCode == 200 && res.ContentLength == a.size {
				interrupted = true
				res.Body = interruptedDownload{Reader: io.LimitReader(res.Body, 1<<20), Closer: res.Body}
			}
			return res, nil
		})
		var err error
		filename, digest, err = fetchInstaller(ctx, client, dir, a, func(n, total int64) {
			if step := n * 10 / total; step != last {
				last = step
				t.Logf("version %s progress %d/10", a.version, step)
			}
		})
		return err
	}
	// Keep the same cache if the bounded retry budget is exhausted. A second
	// user-triggered action can continue a previous partial after a relay outage.
	for click := 0; click < 3; click++ {
		err = withFreshRoute(ctx, a.url, report, download)
		var transient transientNetworkError
		if !errors.As(err, &transient) {
			break
		}
		t.Log("action stopped with resumable partial", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !interrupted || !resumed {
		t.Fatal("expected automatic retry with HTTP 206")
	}
	st, err := os.Stat(filename)
	if err != nil || st.Size() != a.size {
		t.Fatal("installer size mismatch")
	}
	actual, err := fileHash(filename)
	if err != nil || actual != digest {
		t.Fatal("installer hash mismatch")
	}
	t.Log("verified", a.name, st.Size(), actual)
}

func TestRetryOnlyNetworkFailures(t *testing.T) {
	report := func(string) {}
	for _, tc := range []struct {
		name     string
		err      error
		expected int
	}{
		{"5xx", responseStatusError("下载服务", 503), 3},
		{"rate limit", responseStatusError("下载服务", 429), 1},
		{"invalid range", errors.New("续传范围错误"), 1},
		{"filesystem", os.ErrPermission, 1},
		{"digest", errors.New("SHA-256 校验失败"), 1},
		{"tls", safeNetworkFailure("证书验证失败", x509.UnknownAuthorityError{}), 1},
		{"cancelled", context.Canceled, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			visits := 0
			err := retryTransfer(context.Background(), report, func() error { visits++; return tc.err })
			if err == nil || visits != tc.expected {
				t.Fatal("rounds", visits, "expected", tc.expected, err)
			}
		})
	}
}
func TestTransferRetryRechecksManifestAndResumes(t *testing.T) {
	data := "abcdefgh"
	expected := fmt.Sprintf("%x", sha256.Sum256([]byte(data)))
	a := installerAsset{name: "Brclio-9.0.0-mac-arm64.dmg", size: 8, checksumURL: "https://github.com/checksum", url: "https://github.com/installer", digest: expected}
	dir := t.TempDir()
	routes, manifests := 0, 0
	err := retryTransfer(context.Background(), func(string) {}, func() error {
		routes++
		response := func(r *http.Request) (*http.Response, error) {
			status := 200
			h := http.Header{}
			value := expected + "  " + a.name + "\n"
			size := int64(len(value))
			if r.URL.String() == a.url {
				if routes == 1 {
					value = data[:3]
					size = 8
				} else {
					if r.Header.Get("Range") != "bytes=3-" {
						t.Fatal("invalid Range", r.Header.Get("Range"))
					}
					value = data[3:]
					status = 206
					size = 5
					h.Set("Content-Range", "bytes 3-7/8")
				}
			} else {
				manifests++
			}
			return &http.Response{StatusCode: status, ContentLength: size, Header: h, Body: io.NopCloser(strings.NewReader(value))}, nil
		}
		client := &http.Client{Transport: testRoundTrip(response)}
		_, hash, err := fetchInstaller(context.Background(), client, dir, a, func(int64, int64) {})
		if err == nil && hash != expected {
			t.Fatal("invalid digest")
		}
		return err
	})
	if err != nil || routes != 2 || manifests != 2 {
		t.Fatal(err, routes, manifests)
	}
}
