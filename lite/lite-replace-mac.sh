set -eu
pid=$1
target=$2
old_id=$3
candidate=$4
action=$5
stage=$(/usr/bin/dirname "$candidate")
fail() {
  /usr/bin/osascript -e 'display alert "Brclio Downloader Lite 更新失败" message "请重新打开下载器。恢复文件保留在应用程序目录。"' >/dev/null 2>&1 || :
  exit 1
}
rename_app() {
  /usr/bin/osascript -l JavaScript -e 'ObjC.bindFunction("renamex_np",["int",["char *","char *","unsigned int"]]);function run(argv){if($.renamex_np(argv[0],argv[1],Number(argv[2]))!==0)throw Error("Could not replace application");}' "$candidate" "$target" "$1"
}
for attempt in $(/usr/bin/jot 90); do
  if ! /bin/kill -0 "$pid" 2>/dev/null; then break; fi
  /bin/sleep 1
done
/bin/kill -0 "$pid" 2>/dev/null && fail
if [ "$old_id" != '-' ]; then
  [ ! -L "$target" ] && [ "$(/usr/bin/stat -f '%d:%i' "$target")" = "$old_id" ] || fail
fi
if [ "$action" = install ]; then
  /usr/bin/codesign --verify --deep --strict "$candidate" || fail
  if [ "$old_id" = '-' ]; then rename_app 4 || fail; else rename_app 2 || fail; fi
fi
if ! /usr/bin/open -a "$target"; then
  if [ "$action" = install ] && [ "$old_id" != '-' ]; then rename_app 2 || fail; /usr/bin/open -a "$target" || :; fi
  fail
fi
/bin/rm -rf "$stage"
