# Finder 右键扩展

`BrclioFinderSync.appex` 为文件、多选、文件夹及文件夹空白处提供一级菜单“复制路径 · Brclio”。扩展只把选中的绝对文件路径交给其容器 Brclio，继续使用桌面客户端已有的格式设置与剪贴板实现。

```sh
node scripts/build-mac-finder-extension.mjs --arch arm64 --version 0.1.1
node scripts/build-mac-finder-extension.mjs --arch x64 --version 0.1.1 --output /path/Brclio.app/Contents/PlugIns/BrclioFinderSync.appex
node native/macos/test.mjs
```

需要 macOS 和 Xcode 命令行工具。默认输出 `native/macos/build/<arch>/BrclioFinderSync.appex`。构建脚本编译、使用独立沙盒权限 ad-hoc 签名，再验证签名、权限及架构；构建不会注册或启用扩展。Bundle ID 为 `com.brclio.toolbox.finder-sync`，主类为 `BrclioFinderSync.FinderSync`。

扩展将 `/` 登记为 Finder UI 覆盖范围，请求包含主目录、系统文件夹及外置卷。它不遍历磁盘、不读取文件内容，也不处理徽章或目录观察回调。它仅申请 App Sandbox 和用户所选文件只读权限，不申请 App Groups、Apple Events 或网络权限。

Finder Sync 不能保证所有 Finder 视图都显示菜单：[Apple DTS 说明](https://developer.apple.com/forums/thread/766680)部分特殊 Applications 视图会绕过扩展，多个扩展对同一文件夹的覆盖也可能冲突。应分别验证 Desktop、普通实体文件夹、外置卷和当前系统版本，不把根目录登记视为全盘可用的证明。

沙盒扩展的 `NSWorkspace.OpenConfiguration.arguments` 会被系统忽略，因此这里采用定向到容器的 `NSWorkspace.open(_:withApplicationAt:configuration:)` URL 事件，允许复用另一个磁盘位置上、已运行且能处理该 URL 的 Brclio 副本，避免单实例锁丢失事件。URL 唯一格式为 `brclio://copy-path?payload=<base64url(JSON paths)>`；最多 1000 项、JSON 最多 128 KiB，仅绝对路径且拒绝 C0/C1 控制字符，保留 emoji 的零宽连接符。不通过 shell，不依赖默认 URL handler。

编译和 ad-hoc 签名完整性并不代表已获 Developer ID、公证或 Gatekeeper 信任；是否可被系统加载、是否已启用、Finder 中是否显示菜单，需在装入完整 Brclio.app 后分别验证。用户必须在 macOS 系统设置中允许 Finder 扩展。请勿把注册成功等同于菜单与复制已验证。

Apple 参考：[Finder Sync 扩展](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Finder.html)、[沙盒调用者的 arguments 限制](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/arguments)。

Finder 的远程菜单不保留任意 `representedObject`。菜单用 `tag` 关联扩展内的选区快照（最多 32 份），点击后消费快照；不能在点击时重新读取可能已经变化的选区。
