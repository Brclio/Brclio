#!/bin/sh
# All arguments are filesystem paths chosen by the bootstrap process. Run from
# outside both bundles so Launch Services can open the new copy after it exits.
set -eu
parent=$1
stage=$2
target=$3
old_id=$4
fail() {
  /usr/bin/osascript -e 'display alert "Brclio 下载器更新失败" message "请重新打开下载器并重试。已有应用和恢复文件会保留在应用程序目录。"' >/dev/null 2>&1 || :
  exit 1
}
for attempt in $(/usr/bin/jot 90); do
  if ! /bin/kill -0 "$parent" 2>/dev/null; then break; fi
  /bin/sleep 1
done
if /bin/kill -0 "$parent" 2>/dev/null; then fail; fi
candidate="$stage/next.app"
/usr/bin/codesign --verify --deep --strict "$candidate" || fail
if [ "$old_id" = '-' ]; then
  [ ! -e "$target" ] && [ ! -L "$target" ] || fail
else
  [ ! -L "$target" ] && [ "$(/usr/bin/stat -f '%d:%i' "$target")" = "$old_id" ] || fail
  /bin/mv "$target" "$stage/previous.app" || fail
fi
if ! /bin/mv "$candidate" "$target"; then
  if [ -d "$stage/previous.app" ] && [ ! -e "$target" ]; then /bin/mv "$stage/previous.app" "$target" || :; fi
  fail
fi
if ! /usr/bin/open -a "$target"; then
  /bin/mv "$target" "$stage/failed.app" || fail
  if [ -d "$stage/previous.app" ]; then /bin/mv "$stage/previous.app" "$target" || fail; /usr/bin/open -a "$target" || :; fi
  fail
fi
/bin/rm -rf "$stage"
