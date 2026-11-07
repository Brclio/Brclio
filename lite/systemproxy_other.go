//go:build !windows && !darwin

package main

import "context"

func platformProxy(context.Context, string) (string, error) { return "", nil }
