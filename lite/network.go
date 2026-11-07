package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	subscriptionURL   = "https://tools.brclio.com/api/client/update-proxy"
	subscriptionAlias = "https://brclio-client-services.aiyuechuang.workers.dev/api/client/update-proxy"
	probeURL          = "https://github.com/robots.txt"
	gitHubLatest      = "https://api.github.com/repos/Brclio/Brclio/releases/latest"
)

func githubHost(host string) bool {
	switch host {
	case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}
func githubURL(u *url.URL) bool {
	return u != nil && u.Scheme == "https" && u.User == nil && u.Fragment == "" && !u.OmitHost && u.Opaque == "" && githubHost(u.Host)
}
func noNetworkRedirect(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }
func networkTransport() *http.Transport {
	return &http.Transport{
		DialContext:     (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 8 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 30 * time.Second,
		MaxIdleConns: 8, MaxIdleConnsPerHost: 2, DisableCompression: true,
	}
}

func limitedBody(body io.Reader, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(body, max+1))
	if err != nil {
		return nil, safeNetworkFailure("网络响应读取失败", err)
	}
	if int64(len(b)) > max {
		return nil, errors.New("网络响应读取失败或超过大小限制")
	}
	return b, nil
}

type transientNetworkError string

func (err transientNetworkError) Error() string { return string(err) }

func connectionFailure(err error) bool {
	if err == nil || isCertError(err) || errors.Is(err, context.Canceled) {
		return false
	}
	var transient transientNetworkError
	var timeout net.Error
	return errors.As(err, &transient) || errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) ||
		errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) ||
		(errors.As(err, &timeout) && timeout.Timeout())
}

func safeNetworkFailure(message string, err error) error {
	if connectionFailure(err) {
		return transientNetworkError(message)
	}
	return errors.New(message)
}

func responseStatusError(service string, status int) error {
	message := fmt.Sprintf("%s返回 HTTP %d", service, status)
	if status >= 500 && status < 600 {
		return transientNetworkError(message)
	}
	return errors.New(message)
}
func isCertError(err error) bool {
	var certificate *tls.CertificateVerificationError
	var invalid x509.CertificateInvalidError
	var unknown x509.UnknownAuthorityError
	var mismatch x509.HostnameError
	return errors.As(err, &certificate) || errors.As(err, &invalid) || errors.As(err, &unknown) || errors.As(err, &mismatch)
}

func fetchSubscription(ctx context.Context, client *http.Client, endpoint string) (nodes []relayNode, retryAlias bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, false, errors.New("订阅服务地址无效")
	}
	req.Header.Set("Cache-Control", "no-cache, no-store")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Brclio-Lite")
	res, err := client.Do(req)
	if err != nil {
		return nil, connectionFailure(err), safeNetworkFailure("订阅服务连接失败", err)
	}
	defer res.Body.Close()
	if res.StatusCode == 403 && strings.EqualFold(res.Header.Get("cf-mitigated"), "challenge") {
		return nil, true, errors.New("订阅服务连接遭遇验证")
	}
	if res.StatusCode != 200 {
		if res.StatusCode == 502 {
			var problem struct {
				Code string `json:"code"`
			}
			if b, err := limitedBody(res.Body, 32<<10); err == nil && json.Unmarshal(b, &problem) == nil && problem.Code == "proxy_configuration_unsupported" {
				return nil, false, errors.New("订阅节点配置无效")
			}
		}
		return nil, false, responseStatusError("订阅服务", res.StatusCode)
	}
	b, err := limitedBody(res.Body, 32<<10)
	if err != nil {
		return nil, false, err
	}
	nodes, err = parseRelayNodes(b)
	return nodes, false, err
}

func parseRelayNodes(b []byte) ([]relayNode, error) {
	var data struct {
		Version int         `json:"version"`
		TTL     int         `json:"ttlSeconds"`
		Nodes   []relayNode `json:"nodes"`
	}
	invalid := errors.New("订阅节点配置无效")
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(&data) != nil || d.Decode(new(any)) != io.EOF || data.Version != 1 || data.TTL < 1 || data.TTL > 600 || len(data.Nodes) < 1 || len(data.Nodes) > 16 {
		return nil, invalid
	}
	for _, node := range data.Nodes {
		if !node.valid() {
			return nil, invalid
		}
	}
	return data.Nodes, nil
}

type relayProbe struct {
	tr        *http.Transport
	latency   time.Duration
	retryable bool
}

func fastestRelay(ctx context.Context, nodes []relayNode) (*http.Transport, time.Duration, error) {
	results := make(chan relayProbe, len(nodes))
	for _, n := range nodes {
		go func(n relayNode) {
			tr := n.tunnelTransport(ctx)
			probe, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(probe, http.MethodHead, probeURL, nil)
			req.Header.Set("Cache-Control", "no-cache")
			start := time.Now()
			res, err := (&http.Client{Transport: tr, CheckRedirect: noNetworkRedirect}).Do(req)
			elapsed := time.Since(start)
			if res != nil {
				res.Body.Close()
			}
			if err != nil || res.StatusCode != 200 || strings.EqualFold(res.Header.Get("cf-mitigated"), "challenge") {
				tr.CloseIdleConnections()
				retryable := connectionFailure(err)
				if err == nil {
					retryable = res.StatusCode >= 500 && res.StatusCode < 600 && !strings.EqualFold(res.Header.Get("cf-mitigated"), "challenge")
				}
				results <- relayProbe{retryable: retryable}
				return
			}
			results <- relayProbe{tr: tr, latency: elapsed}
		}(n)
	}
	var best relayProbe
	allRetryable := true
	for range nodes {
		p := <-results
		if p.tr == nil {
			allRetryable = allRetryable && p.retryable
			continue
		}
		if best.tr == nil || p.latency < best.latency {
			p, best = best, p
		}
		if p.tr != nil {
			p.tr.CloseIdleConnections()
		}
	}
	if best.tr == nil {
		if allRetryable {
			return nil, 0, transientNetworkError("订阅节点测速均连接失败")
		}
		return nil, 0, errors.New("订阅节点测速均失败，请检查网络后重试")
	}
	return best.tr, best.latency, nil
}

// The returned client authorizes the initial request and every redirected hop.
// Only a rate-limited public release lookup may consult the fixed metadata worker.
type githubTransport struct {
	route    http.RoundTripper
	metadata *http.Client
	ctx      context.Context
}

type scopedResponse struct {
	io.ReadCloser
	done func()
}

func (body *scopedResponse) Close() error {
	body.done()
	return body.ReadCloser.Close()
}

func (g *githubTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !githubURL(r.URL) || (r.Host != "" && r.Host != r.URL.Host) || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return nil, errors.New("下载地址必须是官方 GitHub HTTPS 地址")
	}
	if g.ctx.Err() != nil {
		return nil, g.ctx.Err()
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(g.ctx, cancel)
	done := func() { stop(); cancel() }
	res, err := g.request(r.Clone(ctx))
	if err != nil {
		done()
		return nil, err
	}
	res.Body = &scopedResponse{res.Body, done}
	return res, nil
}

func (g *githubTransport) request(r *http.Request) (*http.Response, error) {
	res, err := g.route.RoundTrip(r)
	if err != nil {
		if r.Context().Err() != nil {
			return nil, r.Context().Err()
		}
		if isCertError(err) {
			return nil, errors.New("官方发布服务证书验证失败")
		}
		return nil, safeNetworkFailure("官方发布服务连接失败，请重新检查代理", err)
	}
	if strings.EqualFold(res.Header.Get("cf-mitigated"), "challenge") {
		res.Body.Close()
		return nil, errors.New("官方发布服务拒绝请求")
	}
	if r.Method == http.MethodGet && r.URL.String() == gitHubLatest && (res.StatusCode == 429 || (res.StatusCode == 403 && res.Header.Get("X-Ratelimit-Remaining") == "0")) {
		res.Body.Close()
		fallback, err := g.metadataFallback(r)
		if err != nil {
			return nil, errors.New("版本 API 已限流，备用元数据不可用，请稍后重试")
		}
		return fallback, nil
	}
	return res, nil
}

var stableReleaseTag = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+$`)

func (g *githubTransport) metadataFallback(original *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(original.Context(), 8*time.Second)
	defer cancel()
	endpoint := "https://tools.brclio.com/api/update?url=" + url.QueryEscape(gitHubLatest)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	res, err := g.metadata.Do(req)
	if err != nil {
		return nil, safeNetworkFailure("官方版本元数据服务连接失败", err)
	}
	defer res.Body.Close()
	mediaType, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if res.StatusCode >= 500 && res.StatusCode < 600 && !strings.EqualFold(res.Header.Get("cf-mitigated"), "challenge") {
		return nil, responseStatusError("官方版本元数据服务", res.StatusCode)
	}
	if res.StatusCode != 200 || mediaType != "application/json" || strings.EqualFold(res.Header.Get("cf-mitigated"), "challenge") {
		return nil, errors.New("官方版本元数据服务不可用")
	}
	data, err := limitedBody(res.Body, 1<<20)
	if err != nil {
		return nil, err
	}
	var release struct {
		Tag        string            `json:"tag_name"`
		URL        string            `json:"html_url"`
		Draft      *bool             `json:"draft"`
		Prerelease *bool             `json:"prerelease"`
		Assets     []json.RawMessage `json:"assets"`
	}
	if json.Unmarshal(data, &release) != nil || !stableReleaseTag.MatchString(release.Tag) || release.URL != "https://github.com/Brclio/Brclio/releases/tag/"+release.Tag || release.Draft == nil || *release.Draft || release.Prerelease == nil || *release.Prerelease || len(release.Assets) == 0 || len(release.Assets) > 128 {
		return nil, errors.New("官方版本信息无效")
	}
	return &http.Response{Status: "200 OK", StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Request: original}, nil
}

func selectNetwork(ctx context.Context, target string, report func(string)) (*http.Client, func(), error) {
	u, err := url.Parse(target)
	if err != nil || !githubURL(u) {
		return nil, nil, errors.New("版本检查地址无效")
	}
	proxy, configured, err := systemProxyFor(ctx, target)
	if err != nil {
		return nil, nil, errors.New("无法读取系统代理设置")
	}
	action, stop := context.WithCancel(ctx)
	metadataRoute := networkTransport()
	metadata := &http.Client{Transport: metadataRoute, CheckRedirect: noNetworkRedirect}
	var route *http.Transport
	if configured {
		if report != nil {
			report("使用系统代理")
		}
		metadataRoute.Proxy = proxy
		route = metadataRoute
	} else {
		if report != nil {
			report("刷新订阅")
		}
		nodes, alias, err := fetchSubscription(action, metadata, subscriptionURL)
		if err != nil && alias && action.Err() == nil {
			nodes, _, err = fetchSubscription(action, metadata, subscriptionAlias)
		}
		if err == nil {
			if report != nil {
				report("测速并选择节点")
			}
			var elapsed time.Duration
			route, elapsed, err = fastestRelay(action, nodes)
			if err == nil && report != nil {
				report(fmt.Sprintf("内置代理 · 最低延迟 %d ms", elapsed.Milliseconds()))
			}
		}
		if err != nil {
			stop()
			metadataRoute.CloseIdleConnections()
			return nil, nil, err
		}
	}
	client := &http.Client{Transport: &githubTransport{route: route, metadata: metadata, ctx: action}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 || !githubURL(req.URL) {
			return errors.New("发布文件重定向不受信任")
		}
		return nil
	}}
	return client, func() { stop(); route.CloseIdleConnections(); metadataRoute.CloseIdleConnections() }, nil
}
