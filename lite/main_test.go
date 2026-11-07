package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalLauncherActionsAndIsolation(t *testing.T) {
	dir := t.TempDir()
	link := make(chan string, 1)
	actions := make(chan string, 1)
	resume := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- serveLauncher(dir, func(s string) error { link <- s; return nil },
			func(ctx context.Context, a, d string, report func(string), progress func(int64, int64)) (bool, error) {
				actions <- a
				report("fixture " + a)
				progress(3, 9)
				select {
				case <-resume:
				case <-ctx.Done():
				}
				return false, nil
			}, nil)
	}()
	var entry string
	select {
	case entry = <-link:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(4 * time.Second):
		t.Fatal("launch timeout")
	}
	u, err := url.Parse(entry)
	if err != nil {
		t.Fatal(err)
	}
	key := u.Fragment
	u.Fragment = ""
	origin := strings.TrimSuffix(u.String(), "/")
	request := func(method, path, token, from string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest(method, origin+path, nil)
		if token != "" {
			req.Header.Set("X-Lite-Key", token)
		}
		if from != "" {
			req.Header.Set("Origin", from)
		}
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		body, _ := io.ReadAll(r.Body)
		return r.StatusCode, body
	}
	waitIdle := func() {
		t.Helper()
		for i := 0; i < 100; i++ {
			_, body := request("GET", "/state", key, "")
			var snap view
			if json.Unmarshal(body, &snap) != nil {
				t.Fatal("bad state")
			}
			if !snap.Busy {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("still busy")
	}
	waitAction := func(want string) {
		t.Helper()
		select {
		case got := <-actions:
			if got != want {
				t.Fatalf("wanted %s got %s", want, got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("action timeout")
		}
	}
	waitAction("startup")
	if c, b := request("GET", "/", "", ""); c != 200 || !strings.Contains(string(b), "下载或升级 Brclio") {
		t.Fatal("missing UI", c)
	}
	for _, r := range []struct {
		path, key, from string
		code            int
	}{
		{"/action?name=self", "", "", 403}, {"/action?name=self", key, "https://other.example", 403}, {"/action?name=self", key, origin, 409}, {"/close", key, origin, 409}} {
		if c, _ := request("POST", r.path, r.key, r.from); c != r.code {
			t.Fatalf("%s got %d", r.path, c)
		}
	}
	if err := serveLauncher(dir, func(s string) error {
		if s != entry {
			t.Fatal("second launch changed instance")
		}
		return nil
	}, nil, nil); err != nil {
		t.Fatal(err)
	}
	resume <- struct{}{}
	waitIdle()
	for _, action := range []string{"self", "brclio"} {
		if c, _ := request("POST", "/action?name="+action, key, origin); c != 202 {
			t.Fatal(c)
		}
		waitAction(action)
		resume <- struct{}{}
		waitIdle()
	}
	if c, _ := request("POST", "/preference?enabled=false", key, origin); c != 204 {
		t.Fatal(c)
	}
	if _, err = os.Stat(filepath.Join(dir, "skip-self-update")); err != nil {
		t.Fatal(err)
	}
	if c, _ := request("POST", "/close", key, origin); c != 204 {
		t.Fatal(c)
	}
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("did not quit")
	}
}
