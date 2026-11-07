package main

/*
#cgo LDFLAGS: -framework AppKit
void runLiteApplication(void);
void stopLiteApplication(void);
*/
import "C"

import (
	"runtime"
	"sync"
)

func init() {
	// AppKit must enter NSApplication.run on the original process thread.
	runtime.LockOSThread()
}

var macLaunched = make(chan struct{})
var macSession struct {
	sync.Mutex
	entry     string
	launcher  *launcher
	reopening bool
}

//export liteDidFinishLaunching
func liteDidFinishLaunching() {
	close(macLaunched)
}

//export liteReopen
func liteReopen() {
	macSession.Lock()
	entry := macSession.entry
	if entry == "" || macSession.reopening {
		macSession.Unlock()
		return
	}
	macSession.reopening = true
	macSession.Unlock()
	go func() {
		defer func() {
			macSession.Lock()
			macSession.reopening = false
			macSession.Unlock()
		}()
		// A click in the Dock reopens the same session. It never starts a download.
		if err := openBrowser(entry); err != nil {
			macSession.Lock()
			l := macSession.launcher
			macSession.Unlock()
			if l != nil {
				l.report("无法重新打开浏览器页面")
			}
		}
	}()
}

//export liteRequestQuit
func liteRequestQuit() C.int {
	macSession.Lock()
	l := macSession.launcher
	macSession.Unlock()
	if l != nil && l.quitIfIdle() {
		return 1
	}
	return 0
}

func runDesktopLauncher(dir string) error {
	done := make(chan error, 1)
	go func() {
		<-macLaunched
		err := serveLauncher(dir, openBrowser, runLite, func(entry string, l *launcher) {
			macSession.Lock()
			macSession.entry, macSession.launcher = entry, l
			macSession.Unlock()
		})
		macSession.Lock()
		macSession.entry, macSession.launcher = "", nil
		macSession.Unlock()
		done <- err
		C.stopLiteApplication()
	}()
	C.runLiteApplication()
	return <-done
}
