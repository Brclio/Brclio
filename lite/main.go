package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed VERSION
var versionFile string

//go:embed notices/Go.txt
var goLicense string

//go:embed notices/WebSocket.txt
var websocketLicense string

//go:embed index.html
var page string

func liteVersion() string { return strings.TrimSpace(versionFile) }

type view struct {
	Version  string `json:"version"`
	Status   string `json:"status"`
	Route    string `json:"route"`
	Busy     bool   `json:"busy"`
	Done     int64  `json:"done"`
	Total    int64  `json:"total"`
	AutoSelf bool   `json:"autoSelf"`
}
type operation func(context.Context, string, string, func(string), func(int64, int64)) (bool, error)

type launcher struct {
	run      operation
	mu       sync.Mutex
	view     view
	lastView time.Time
	dir      string
	stop     context.CancelFunc
}

func (l *launcher) report(s string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.view.Status = s
	if strings.Contains(s, "代理") || strings.Contains(s, "节点") {
		l.view.Route = s
	}
}
func (l *launcher) progress(n, total int64) {
	l.mu.Lock()
	l.view.Done = n
	l.view.Total = total
	l.mu.Unlock()
}

func (l *launcher) start(ctx context.Context, action string) bool {
	l.mu.Lock()
	if l.view.Busy {
		l.mu.Unlock()
		return false
	}
	if action == "startup" && !l.view.AutoSelf {
		action = "brclio"
	}
	l.view.Busy = true
	l.view.Status = "正在检查下载线路"
	l.view.Route = ""
	l.view.Done = 0
	l.view.Total = 0
	l.mu.Unlock()
	go func() {
		exit, err := l.run(ctx, action, filepath.Join(l.dir, "packages"), l.report, l.progress)
		l.mu.Lock()
		l.view.Busy = false
		l.lastView = time.Now()
		if err != nil {
			l.view.Status = err.Error()
		}
		l.mu.Unlock()
		if exit {
			l.stop()
		}
	}()
	return true
}
func openBrowser(addr string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("/usr/bin/open", addr)
	case "windows":
		cmd = exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", addr)
	default:
		return errors.New("不支持当前平台")
	}
	return cmd.Run()
}
func launcherDir() (string, error) {
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	d = filepath.Join(d, "Brclio Downloader Lite")
	return d, os.MkdirAll(d, 0700)
}

func desktopApp() error {
	dir, err := launcherDir()
	if err != nil {
		return err
	}
	return serveLauncher(dir, openBrowser, runLite)
}

func serveLauncher(dir string, open func(string) error, run operation) error {
	portFile := filepath.Join(dir, "active.json")
	lock, err := takeLock(filepath.Join(dir, "instance.lock"))
	if err != nil {
		return err
	}
	if lock == nil {
		// A second double-click reopens the already-running launcher.
		for i := 0; i < 20; i++ {
			b, err := os.ReadFile(portFile)
			if err == nil {
				var link string
				if json.Unmarshal(b, &link) == nil && strings.HasPrefix(link, "http://127.0.0.1:") {
					return open(link)
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		return errors.New("便捷版已在运行，请稍后重试")
	}
	defer lock.Close()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close()
	keyBytes := make([]byte, 32)
	if _, err = rand.Read(keyBytes); err != nil {
		return err
	}
	key := hex.EncodeToString(keyBytes)
	host := ln.Addr().String()
	origin := "http://" + host
	entry := origin + "/#" + key
	b, _ := json.Marshal(entry)
	if err = os.WriteFile(portFile, b, 0600); err != nil {
		return err
	}
	defer os.Remove(portFile)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	prefFile := filepath.Join(dir, "skip-self-update")
	_, prefErr := os.Stat(prefFile)
	if prefErr != nil && !os.IsNotExist(prefErr) {
		return prefErr
	}
	l := launcher{run: run, dir: dir, stop: stop, view: view{Version: liteVersion(), Status: "准备下载", AutoSelf: os.IsNotExist(prefErr)}, lastView: time.Now()}
	srv := &http.Server{ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 10 * time.Second, MaxHeaderBytes: 8192}
	srv.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Host != host {
			http.Error(w, "invalid host", 403)
			return
		}
		if r.URL.Path == "/licenses" && r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprint(w, "Go\n\n"+goLicense+"\n\nWebSocket\n\n"+websocketLicense)
			return
		}
		if r.URL.Path == "/" && r.Method == http.MethodGet {
			w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			io.WriteString(w, page)
			return
		}
		if subtle.ConstantTimeCompare([]byte(key), []byte(r.Header.Get("X-Lite-Key"))) != 1 || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != origin) {
			http.Error(w, "forbidden", 403)
			return
		}
		switch {
		case r.URL.Path == "/state" && r.Method == "GET":
			l.mu.Lock()
			v := l.view
			l.lastView = time.Now()
			l.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(v)
		case r.URL.Path == "/action" && r.Method == "POST":
			a := r.URL.Query().Get("name")
			if a != "self" && a != "brclio" {
				http.Error(w, "未知操作", 400)
				return
			}
			if !l.start(ctx, a) {
				http.Error(w, "已有任务正在运行", 409)
				return
			}
			w.WriteHeader(202)
		case r.URL.Path == "/preference" && r.Method == "POST":
			l.mu.Lock()
			defer l.mu.Unlock()
			v := r.URL.Query().Get("enabled")
			var err error
			if v == "true" {
				err = os.Remove(prefFile)
				if os.IsNotExist(err) {
					err = nil
				}
			} else if v == "false" {
				err = os.WriteFile(prefFile, nil, 0600)
			} else {
				http.Error(w, "设置无效", 400)
				return
			}
			if err != nil {
				http.Error(w, "无法保存设置", 500)
				return
			}
			l.view.AutoSelf = v == "true"
			w.WriteHeader(204)
		case r.URL.Path == "/close" && r.Method == "POST":
			l.mu.Lock()
			busy := l.view.Busy
			l.mu.Unlock()
			if busy {
				http.Error(w, "操作完成后可以退出", 409)
				return
			}
			w.WriteHeader(204)
			stop()
		default:
			http.NotFound(w, r)
		}
	})
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			stop()
		}
	}()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	if err = open(entry); err != nil {
		return err
	}
	l.start(ctx, "startup")
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			l.mu.Lock()
			idle := !l.view.Busy && time.Since(l.lastView) > 2*time.Minute
			l.mu.Unlock()
			if idle {
				return nil
			}
		}
	}
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(liteVersion())
		return
	}
	var err error
	if len(os.Args) == 2 && os.Args[1] == "--check" {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, err = runLite(ctx, "check", "", func(s string) { fmt.Println(s) }, func(int64, int64) {})
	} else if len(os.Args) == 1 || (len(os.Args) == 2 && strings.HasPrefix(os.Args[1], "-psn_")) {
		err = desktopApp()
	} else {
		err = errors.New("可选参数为 --version 或 --check")
	}
	if err != nil {
		if len(os.Args) == 1 {
			switch runtime.GOOS {
			case "darwin":
				_ = exec.Command("/usr/bin/osascript", "-e", `on run argv
display alert "Brclio 便捷版" message (item 1 of argv)
end run`, err.Error()).Run()
			case "windows":
				cmd := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:BRCLIO_LITE_ERROR,'Brclio Downloader Lite')`)
				cmd.Env = append(os.Environ(), "BRCLIO_LITE_ERROR="+err.Error())
				_ = cmd.Run()
			}
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
