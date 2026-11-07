//go:build !darwin

package main

func runDesktopLauncher(dir string) error {
	return serveLauncher(dir, openBrowser, runLite, nil)
}
