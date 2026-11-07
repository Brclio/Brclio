package main

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type relayNode struct {
	UUID        string `json:"uuid"`
	Host        string `json:"host"`
	DialAddress string `json:"dialAddress"`
	Port        int    `json:"port"`
	Path        string `json:"path"`
	ServerName  string `json:"servername"`
	WSHost      string `json:"wsHost"`
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var dnsLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
var dnsTLD = regexp.MustCompile(`^[a-z]{2,63}$`)

func publicName(s string) bool {
	if len(s) > 253 {
		return false
	}
	labels := strings.Split(s, ".")
	if len(labels) < 2 || !dnsTLD.MatchString(labels[len(labels)-1]) || s == "home.arpa" || strings.HasSuffix(s, ".home.arpa") {
		return false
	}
	switch labels[len(labels)-1] {
	case "local", "localhost", "internal", "invalid", "test", "example", "onion", "lan", "home":
		return false
	}
	for _, label := range labels {
		if !dnsLabel.MatchString(label) {
			return false
		}
	}
	return true
}

var nonPublicRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

func publicIPv4(ip netip.Addr) bool {
	if !ip.Is4() || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, prefix := range nonPublicRanges {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}
func (n relayNode) valid() bool {
	if !uuidPattern.MatchString(n.UUID) || !publicName(n.Host) || n.Host != n.ServerName || n.Host != n.WSHost {
		return false
	}
	if ip, err := netip.ParseAddr(n.DialAddress); err == nil {
		if !publicIPv4(ip) {
			return false
		}
	} else if !publicName(n.DialAddress) {
		return false
	}
	switch n.Port {
	case 443, 2053, 2083, 2087, 2096, 8443:
	default:
		return false
	}
	if len(n.Path) > 2048 || !strings.HasPrefix(n.Path, "/") || strings.HasPrefix(n.Path, "//") || strings.ContainsAny(n.Path, "\\#") {
		return false
	}
	for _, b := range []byte(n.Path) {
		if b < 0x21 || b > 0x7e {
			return false
		}
	}
	_, err := url.PathUnescape(n.Path)
	return err == nil
}

// Resolve once, validate each returned address, and connect to the literal IP.
// The original hostname remains the HTTP Host and TLS certificate identity.
func (n relayNode) dialPublic(ctx context.Context, network, address string) (net.Conn, error) {
	if address != net.JoinHostPort(n.Host, strconv.Itoa(n.Port)) {
		return nil, errors.New("代理目标无效")
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", n.DialAddress)
	if err != nil {
		return nil, safeNetworkFailure("无法解析代理节点", err)
	}
	var last error
	for _, ip := range ips {
		if ip = ip.Unmap(); !publicIPv4(ip) {
			continue
		}
		conn, err := (&net.Dialer{Timeout: 4 * time.Second}).DialContext(ctx, "tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(n.Port)))
		if err == nil {
			return conn, nil
		}
		last = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, safeNetworkFailure("无法连接公网代理节点", last)
}

type vlessConn struct {
	net.Conn
	ws         *websocket.Conn
	headerOnce sync.Once
	headerErr  error
}

func (c *vlessConn) Read(p []byte) (int, error) {
	c.headerOnce.Do(func() {
		var header [2]byte
		if _, c.headerErr = io.ReadFull(c.Conn, header[:]); c.headerErr != nil {
			return
		}
		if header[0] != 0 {
			c.headerErr = errors.New("节点返回了无效的 VLESS 响应")
			return
		}
		_, c.headerErr = io.CopyN(io.Discard, c.Conn, int64(header[1]))
	})
	if c.headerErr != nil {
		return 0, c.headerErr
	}
	return c.Conn.Read(p)
}

func (c *vlessConn) Close() error {
	if c.ws != nil {
		_ = c.ws.CloseNow()
	}
	return c.Conn.Close()
}

func (n relayNode) tunnelTransport(lifetime context.Context) *http.Transport {
	outer := networkTransport()
	outer.DialContext = n.dialPublic
	outer.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: n.ServerName}
	wsClient := &http.Client{Transport: outer, CheckRedirect: noNetworkRedirect}
	endpoint := "wss://" + net.JoinHostPort(n.Host, strconv.Itoa(n.Port)) + n.Path
	id, _ := hex.DecodeString(strings.ReplaceAll(n.UUID, "-", ""))
	tr := networkTransport()
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		hostname, port, err := net.SplitHostPort(address)
		if err != nil || port != "443" || !githubHost(hostname) {
			return nil, errors.New("代理目标不属于官方发布服务")
		}
		handshake, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		ws, response, err := websocket.Dial(handshake, endpoint, &websocket.DialOptions{HTTPClient: wsClient, Host: n.WSHost})
		if err != nil {
			if response != nil && response.StatusCode >= 500 && response.StatusCode < 600 && !strings.EqualFold(response.Header.Get("cf-mitigated"), "challenge") {
				return nil, transientNetworkError("代理节点暂时不可用")
			}
			return nil, safeNetworkFailure("节点 TLS 或 WebSocket 握手失败", err)
		}
		header := append([]byte{0}, id...)
		header = append(header, 0, 1, 1, 187, 2, byte(len(hostname))) // TCP, 443, domain name
		header = append(header, hostname...)
		if err = ws.Write(handshake, websocket.MessageBinary, header); err != nil {
			_ = ws.CloseNow()
			return nil, safeNetworkFailure("节点连接失败", err)
		}
		conn := websocket.NetConn(lifetime, ws, websocket.MessageBinary)
		ws.SetReadLimit(8 << 20)
		return &vlessConn{Conn: conn, ws: ws}, nil
	}
	return tr
}
