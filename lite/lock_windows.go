package main

import (
	"errors"
	"os"
	"syscall"
)

func takeLock(p string) (*os.File, error) {
	name, e := syscall.UTF16PtrFromString(p)
	if e != nil {
		return nil, e
	}
	h, e := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if e != nil {
		if errors.Is(e, syscall.Errno(32)) {
			return nil, nil
		}
		return nil, e
	}
	return os.NewFile(uintptr(h), p), nil
}
