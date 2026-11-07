//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

func takeLock(p string) (*os.File, error) {
	f, e := os.OpenFile(p, os.O_RDWR|os.O_CREATE, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		if errors.Is(e, syscall.EWOULDBLOCK) {
			return nil, nil
		}
		return nil, e
	}
	return f, nil
}
