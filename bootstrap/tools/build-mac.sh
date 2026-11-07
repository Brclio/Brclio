#!/usr/bin/env bash
set -euo pipefail

arch=${1:-}
case "$arch" in
  arm64) folder=mac-arm64 ;;
  x64) folder=mac ;;
  *) echo 'Usage: bash bootstrap/tools/build-mac.sh arm64|x64' >&2; exit 2 ;;
esac
cd "$(dirname "$0")/../.."
version=$(node -p "require('./bootstrap/package.json').version")
output=release/downloader
bundle="$output/$folder/Brclio Downloader.app"
npx --no-install electron-builder --config bootstrap/electron-builder.cjs --mac "--$arch" --dir --publish never
codesign --verify --deep --strict "$bundle"

work=$(mktemp -d "$output/.image-$arch.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir "$work/contents"
ditto "$bundle" "$work/contents/Brclio Downloader.app"
ln -s /Applications "$work/contents/Applications"
hdiutil create -quiet -volname "Brclio Downloader $version $arch" -srcfolder "$work/contents" -fs HFS+ -format UDZO "$work/installer.dmg"
hdiutil verify -quiet "$work/installer.dmg"
mv "$work/installer.dmg" "$output/Brclio-Downloader-$version-mac-$arch.dmg"
