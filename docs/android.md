# Android 客户端

Android 客户端使用 Kotlin Activity 和离线 WebView，共用 `web/` 中的 Brclio 界面。包名为 `com.brclio.toolbox`，调试包为 `com.brclio.toolbox.debug`，当前版本 `0.1.0`，最低 Android 8.0（API 26）。

## 使用方式

1. 打开 Brclio，选择文件或文件夹。文件选择支持多选，文件夹选择由系统 Storage Access Framework 提供。
2. 在应用内设置绝对/相对路径、相对路径基准目录、引号、分隔符、文件夹末尾斜杠和多项连接方式。
3. 点击复制，或长按应用内的路径预览进行复制。
4. 在支持文件分享的文件管理器中，选择文件后使用“分享 → Brclio”。客户端接收 `ACTION_SEND`、`ACTION_SEND_MULTIPLE` 和 `ACTION_VIEW`。

Android 没有跨所有文件管理器的统一右键扩展接口，因此本版提供系统选择器、分享入口和应用内长按复制。它不会显示已经安装了系统右键扩展。Android 也不提供本应用中的“开机启动”选项。

## 路径与系统限制

- `com.android.externalstorage.documents` 的 `primary:` 文档标识可对应主共享存储的路径，例如 `/storage/emulated/0/Documents/计划.pdf`。客户端仅对这个已知映射返回绝对路径，拒绝 `..`、前导斜杠、空字符等异常标识。
- 云盘、下载 Provider、第三方文件管理器和未知外置存储卷可能只提供 `content://...`。客户端保留并标记原始 URI，不拼接一个貌似有效的文件路径。
- URI 不是本机文件系统路径，不能使用文件系统的相对路径或分隔符转换。共享界面应明确显示 URI 类型。复制 URI 不会将该文件的访问权限授予接收文本的其他应用。
- 已知的绝对路径是位置文本；Android 的沙盒限制仍然决定其他应用是否能访问该位置。
- Android 11 及以上对某些文件夹的选择施加限制，包括存储根目录、下载目录根目录和 `Android/data`、`Android/obb`。这些限制由系统选择器执行。
- 路径功能不读取文件内容，不请求所有文件访问或旧版广泛存储权限。所选 URI 仅用于获取名称和位置；不保留长期文件访问授权。网络权限仅用于原生在线更新；安装更新需用户授予 Brclio 安装应用的权限。

## 在线更新

客户端从 `Brclio/Brclio` 的 GitHub Releases 查询最新正式版，只接受稳定的 `vX.Y.Z` 版本。Android 附件名必须为 `Brclio-X.Y.Z-android.apk`，并在 `SHA256SUMS.txt` 中具有唯一校验记录。

下载在原生后台线程执行，展示字节数和百分比；连接 15 秒、读取 30 秒超时，整次下载最多 10 分钟，最多跟随 6 次 HTTPS 重定向。仅接受 GitHub 官方下载域名。下载大小必须与 Release 记录一致，并通过 SHA-256、包名、版本号、版本代码和当前应用签名证书校验。失败会删除临时文件，用户可以重试。

校验通过的 APK 存在应用私有缓存 `updates/` 中，仅使用受限 `FileProvider` URI 交给系统安装程序。首次安装需进入系统设置允许 Brclio 安装应用，再返回点击安装。打开安装程序只是交给系统继续操作；完成安装并重新打开 Brclio、确认版本后，才算更新成功。应用进程重启后会清理旧下载缓存，需要重新下载。调试包和正式包使用不同包名及签名，因此不能互相作为原位更新安装。

## 构建

需要完整 JDK 17、Android SDK 35 和 Build Tools 35.0.0。构建版本固定为 AGP 8.9.2、Gradle 8.11.1、Kotlin 2.2.21、AndroidX WebKit 1.12.1。

设置 `JAVA_HOME` 和 `ANDROID_HOME` 后执行：

```sh
cd android
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Gradle 的 `syncWebAssets` 会自动将项目的 `web/` 和 `core/` 拷贝进 APK，并将 `core/path-engine.cjs` 生成到 `assets/web/path-engine.js`，不需要先运行 npm。生成的 assets 不纳入版本控制。

调试 APK：`android/app/build/outputs/apk/debug/app-debug.apk`。调试版本启用 WebView 调试功能，正式版本关闭。

正式 APK 必须显式配置以下环境变量；缺少任意一项会停止正式打包：

```text
ANDROID_SIGNING_STORE_FILE
ANDROID_SIGNING_STORE_PASSWORD
ANDROID_SIGNING_KEY_ALIAS
ANDROID_SIGNING_KEY_PASSWORD
```

密钥库路径相对于 `android/`，也可以使用绝对路径。不要将密钥库或密码纳入版本控制。配置后运行 `./gradlew :app:assembleRelease`。

Gradle Wrapper JAR 的 SHA-256 固定为 `2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`；Gradle 分发包的 SHA-256 由 `gradle-wrapper.properties` 校验。

## 原生桥接协议

共享界面调用：

```js
AndroidBridge.postMessage(JSON.stringify({
  id: 'request-1',
  method: 'pickPaths',
  payload: { kind: 'file' }
}));
```

原生完成后调用 `window.__brclioResolve(id, { result, error })`。`error` 成功时为 `null`，失败时为可展示的中文字符串。选取取消返回空数组。

| 方法 | payload | result |
| --- | --- | --- |
| `getPlatform` | `{}` | `{platform:'android', version, capabilities}` |
| `getSettings` | `{}` | 规范化设置对象 |
| `saveSettings` | `{settings}` | 已持久化设置对象 |
| `pickPaths` | `{kind:'file'\|'directory'\|'base'}` | `[{path, name, kind:'file'\|'directory', isUri}]` |
| `copyText` | `{text}` | `{ok:true}` |
| `getIntegrationStatus` | `{}` | `{supported:false, enabled:false, message}` |
| `setIntegration` | 任意 | 平台不支持的错误信息 |
| `checkForUpdates` | `{}` | 更新状态对象 |
| `downloadUpdate` | `{}` | 校验完成后的 `downloaded` 状态 |
| `installUpdate` | `{}` | 状态与 `requiresPermission` 或 `installerOpened` 标记 |

从文件管理器接收的路径通过 `window.dispatchEvent(new CustomEvent('brclio:paths', {detail: paths}))` 送入共享界面。文件选择通过原请求返回，不重复发送事件。

更新进度通过 `brclio:update` 自定义事件发送，`detail` 为 `{status, currentVersion, version, notes, progress, downloadedBytes, totalBytes, error, assetName}`。状态包括 `checking`、`up-to-date`、`available`、`downloading`、`downloaded`、`error`。界面桥接需为下载保留足够的异步等待时间。

设置使用应用私有 `SharedPreferences`，严格校验枚举和类型。Android 始终将 `launchAtLogin` 设为 `false`。本版一次接收最多 128 个共享/选择条目。

桥接使用 `WebViewCompat.addWebMessageListener`，仅允许 `https://appassets.androidplatform.net` 的主框架。主界面从 `/assets/web/index.html` 加载，远程子资源和网络回退均被阻止。远程链接仅可在用户点击后交给外部浏览器，不在具有原生桥接的 WebView 中打开。需要支持 `WEB_MESSAGE_LISTENER` 的系统 WebView；过旧的版本会提示先更新 Android System WebView。

## 验证清单

本地 JUnit 用于验证主存储映射、防目录穿越、设置规范化及 JSON 往返。Gradle lint 与 APK 打包验证原生编译和资源。发布前还应在真实设备上完成：

- 系统文件/文件夹选择、取消和文件多选；中文名与空格。
- 主存储绝对路径、云盘/下载 URI 的明确标记与原样保留。
- 从文件管理器分享单文件、多文件，以及应用已打开时接收分享。
- 引号、相对基准目录、复制按钮、长按预览复制。
- 重启后设置保留、横竖屏布局、输入法和系统返回键。

官方参考：[Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)、[加载本地 Web 内容](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)、[WebView 原生桥接安全](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)、[AGP 8.9 兼容性](https://developer.android.com/build/releases/agp-8-9-0-release-notes)、[Kotlin Gradle 兼容性](https://kotlinlang.org/docs/gradle-configure-project.html)。
