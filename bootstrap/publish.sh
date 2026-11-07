#!/usr/bin/env bash
set -euo pipefail

case ${1:-desktop} in
  desktop)
    version=$(node -p "require('./bootstrap/package.json').version")
    prefix=Brclio-Downloader
    name='Brclio Downloader'
    tag="downloader-v$version"
    channel=downloader-stable
    ;;
  lite)
    version=$(cat lite/VERSION)
    prefix=Brclio-Downloader-Lite
    name='Brclio Downloader Lite'
    tag="lite-v$version"
    channel=lite-stable
    ;;
  *) echo 'Unknown downloader edition.' >&2; exit 2 ;;
esac
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ && "$tag" == "$GITHUB_REF_NAME" ]]
expected=("$prefix-$version-mac-arm64.dmg" "$prefix-$version-mac-x64.dmg" "$prefix-$version-windows-x64.exe")

check_packages() {
  local directory=$1 name
  for name in "${expected[@]}"; do test -s "$directory/$name"; done
  # Only the three installers and the checksum manifest belong to a tagged release.
  test "$(find "$directory" -mindepth 1 -maxdepth 1 | wc -l)" -eq 4
  node scripts/checksums.mjs "$directory" --verify
}

node scripts/checksums.mjs release-files
check_packages release-files
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Public versioned assets stay immutable, including when a failed channel update is retried.
cat > "$work/notes.md" <<NOTES
Windows x64、macOS Apple Silicon 和 macOS Intel 安装包均在本页附件中，每个文件的 SHA-256 见随附的 SHA256SUMS.txt。

打开下载器即可检查 Brclio 最新稳定版。下载器优先使用系统已有的代理；没有代理时自动刷新订阅并测速。安装前会校验安装包，下载中断后可以续传。

macOS 打开 DMG，将应用拖至“应用程序”后双击。Windows 运行对应的 EXE。Mac 包使用 ad-hoc 签名，Windows 包未配置 Authenticode 发行签名。

在 macOS 上，本下载器将 Brclio 客户端安装到系统目录 \`/Applications/Brclio.app\`。若此前从 \`~/Applications/Brclio.app\` 启动了 Brclio，请先退出那份应用，然后运行新版下载器。用户目录中的旧副本会保留。

[官方首次下载入口](https://tools.brclio.com/downloader/) · [Brclio 客户端正式版本](https://github.com/Brclio/Brclio/releases/latest)
NOTES
if ! gh release view "$tag" --json isDraft,isPrerelease > "$work/tag.json"; then
  gh release create "$tag" --verify-tag --draft --prerelease --latest=false --title "$name $version" --notes-file "$work/notes.md"
  gh release view "$tag" --json isDraft,isPrerelease > "$work/tag.json"
fi
jq -e '.isPrerelease' "$work/tag.json" > /dev/null
if jq -e '.isDraft' "$work/tag.json" > /dev/null; then
  gh release upload "$tag" release-files/* --clobber
fi
gh release download "$tag" --dir "$work/versioned"
check_packages "$work/versioned"
if jq -e '.isDraft' "$work/tag.json" > /dev/null; then
  cmp release-files/SHA256SUMS.txt "$work/versioned/SHA256SUMS.txt"
  gh release edit "$tag" --draft=false --prerelease --latest=false
fi

node --input-type=module - "$version" "$work/versioned" > "$work/latest.json" <<'JS'
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const [version, directory] = process.argv.slice(2);
const lines = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
const assets = lines.map(line => {
  const [sha256, name] = line.split('  ');
  return { name, size: statSync(join(directory, name)).size, sha256 };
});
console.log(JSON.stringify({ version, assets }));
JS
if gh release view "$channel" --json assets,isPrerelease,isDraft > "$work/channel.json"; then
  jq -e '.isPrerelease and (.isDraft|not)' "$work/channel.json" > /dev/null
  if jq -e 'any(.assets[]; .name == "latest.json")' "$work/channel.json" > /dev/null; then
    gh release download "$channel" --pattern latest.json --dir "$work/current"
    current=$(jq -er '.version | select(type=="string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))' "$work/current/latest.json")
    if cmp -s "$work/current/latest.json" "$work/latest.json"; then exit 0; fi
    newest=$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)
    if [[ "$newest" != "$version" ]]; then echo 'The channel already points to a newer downloader.'; exit 0; fi
  fi
  gh release upload "$channel" "$work/latest.json" --clobber
else
  gh release create "$channel" "$work/latest.json" --target "$GITHUB_SHA" --prerelease --latest=false --title "$name channel" --notes '下载器当前版本索引'
fi
gh release download "$channel" --pattern latest.json --dir "$work/check"
cmp "$work/latest.json" "$work/check/latest.json"
