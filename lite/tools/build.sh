#!/usr/bin/env bash
set -euo pipefail

target=${1:-all}
cd "$(dirname "$0")/../.."
repo_root=$PWD
version=$(cat lite/VERSION)
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Invalid lite/VERSION.' >&2; exit 1; }
name='Brclio Downloader Lite'
prefix="Brclio-Downloader-Lite-$version"
output="$repo_root/release/lite"
mkdir -p "$output"
work=$(mktemp -d "$output/.build-XXXXXXXX")
trap 'rm -rf "$work"' EXIT

build_mac() {
  local arch=$1 goarch=$1 nativearch=$1 contents="$work/$1" bundle exe
  if [[ $arch == x64 ]]; then goarch=amd64; nativearch=x86_64; fi
  bundle="$contents/$name.app"
  exe="$bundle/Contents/MacOS/$name"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  (cd lite && CGO_ENABLED=1 GOOS=darwin GOARCH="$goarch" CC=clang MACOSX_DEPLOYMENT_TARGET=13.0 \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$exe" .)
  if [[ ! -f "$work/icon.icns" ]]; then
    iconutil -c iconset -o "$work/brand.iconset" resources/icon.icns
    mkdir "$work/lite.iconset"
    cp "$work/brand.iconset"/icon_{16x16,32x32,128x128}*.png "$work/brand.iconset/icon_256x256.png" "$work/lite.iconset/"
    iconutil -c icns -o "$work/icon.icns" "$work/lite.iconset"
  fi
  cp "$work/icon.icns" "$bundle/Contents/Resources/icon.icns"
  cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.brclio.downloader.lite</string>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
  plutil -lint "$bundle/Contents/Info.plist"
  codesign --force --sign - --timestamp=none "$bundle"
  codesign --verify --deep --strict "$bundle"
  test "$(lipo -archs "$exe")" = "$nativearch"
  ln -s /Applications "$contents/Applications"
  hdiutil create -quiet -volname "$name $version $arch" -srcfolder "$contents" -fs HFS+ -format UDZO "$work/$arch.dmg"
  hdiutil verify -quiet "$work/$arch.dmg"
  mv "$work/$arch.dmg" "$output/$prefix-mac-$arch.dmg"
}

build_windows() {
  (cd lite && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
    go build -trimpath -buildvcs=false -ldflags='-H=windowsgui -s -w' -o "$work/lite.exe" .)
  mv "$work/lite.exe" "$output/$prefix-windows-x64.exe"
}

case "$target" in
  mac-arm64) build_mac arm64 ;;
  mac-x64) build_mac x64 ;;
  windows-x64) build_windows ;;
  all) build_mac arm64; build_mac x64; build_windows ;;
  *) echo 'Usage: bash lite/tools/build.sh [all|mac-arm64|mac-x64|windows-x64]' >&2; exit 2 ;;
esac
