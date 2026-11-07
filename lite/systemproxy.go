package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"sync"
)

// Keep each action's PAC results local to the transfer. A new action takes a
// fresh system snapshot, including paths reached through GitHub redirects.
func systemProxyFor(ctx context.Context, target string) (func(*http.Request) (*url.URL, error), bool, error) {
	lookup := func(ctx context.Context, dest string) (*url.URL, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", dest, nil)
		if err != nil {
			return nil, err
		}
		raw, err := platformProxy(ctx, dest)
		if err != nil {
			return nil, errors.New("无法读取系统代理，请检查代理设置后重试")
		}
		if raw == "" {
			return http.ProxyFromEnvironment(req)
		}
		p, err := url.Parse(raw)
		if err != nil || p.Hostname() == "" || (p.Scheme != "http" && p.Scheme != "https" && p.Scheme != "socks5" && p.Scheme != "socks5h") {
			return nil, errors.New("系统代理地址无效")
		}
		return p, nil
	}
	first, err := lookup(ctx, target)
	if err != nil || first == nil {
		return nil, false, err
	}
	var mu sync.Mutex
	cache := map[string]*url.URL{target: first}
	return func(req *http.Request) (*url.URL, error) {
		key := req.URL.String()
		mu.Lock()
		defer mu.Unlock()
		if p, ok := cache[key]; ok {
			return p, nil
		}
		p, err := lookup(req.Context(), key)
		if err == nil {
			cache[key] = p
		}
		return p, err
	}, true, nil
}
