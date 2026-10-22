# 发布 Brclio

仓库为 [Brclio/Brclio](https://github.com/Brclio/Brclio)。`main` 推送与面向 `main` 的 PR 会执行 Node 22 单元测试、真实 Chromium 界面/剪贴板测试、原生桥接契约测试、Android 单元测试和 lint、客户端服务后端测试与 Worker dry build，以及两种 Mac 架构的 FinderSync 编译与沙盒签名检查。浏览器测试使用 Playwright 安装的 Chromium，不依赖开发机上的 Chrome 路径。

## 版本与签名

发布前同步修改 `package.json`、`package-lock.json` 和 `android/app/build.gradle` 的版本，以及 `web/` 中浏览器预览和加载前界面的版本文字。当前流水线接受 `X.Y.Z` 稳定版本，Android `versionCode` 每次发布必须递增。所有安装包都从同一个提交构建。

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 配置以下四个仓库 Secret：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 正式发布 keystore 文件的 Base64 内容 |
| `ANDROID_SIGNING_STORE_PASSWORD` | keystore 密码 |
| `ANDROID_SIGNING_KEY_ALIAS` | 签名 key 的 alias |
| `ANDROID_SIGNING_KEY_PASSWORD` | 签名 key 的密码 |

同一 Android 应用后续更新必须继续使用同一把签名 key；妥善离线备份 keystore 和密码。流水线缺少任何签名 Secret 会失败，绝不发布 unsigned 或 debug APK。签名文件只写入临时目录，并在作业结束时删除。

Android 上传前还运行 `scripts/verify-android-signing.mjs`：用只读 `github.token` 查询 `Brclio/Brclio` 最新已公开稳定版，要求恰好一份符合官方命名与下载地址的 APK，并按固定 asset ID 下载到 `RUNNER_TEMP`；核对文件大小及 GitHub 提供的 SHA-256 digest。工具只用 `apksigner verify --print-certs` 读取新旧 APK 的单一签名证书，要求 SHA-256 证书指纹相同；不安装或执行下载的 APK。元数据、下载、验签或指纹比较失败均阻止上传，日志只输出公钥证书指纹及固定状态，临时旧 APK 始终清理。该检查不需要读取 keystore 或密码，四项签名 Secret 保持原样；计划轮换签名 key 时须另行设计和审查兼容升级流程，不能绕过本门禁。参见 [Android apksigner](https://developer.android.com/tools/apksigner) 和 [GitHub 最新正式 Release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)。

macOS 默认采用完整的 ad-hoc 签名，以验证应用及嵌套组件的完整性；该模式关闭 hardened runtime，尚未使用 Developer ID 和 Apple notarization。浏览器下载后的首次启动仍可能需要在系统设置的“隐私与安全性”中允许打开。Windows 安装包尚未使用 Authenticode 签名。SHA-256 清单用于检查下载是否完整，代码签名完整性、运行能力和 Gatekeeper 信任分别验收。

FinderSync 扩展位于 `Brclio.app/Contents/PlugIns/BrclioFinderSync.appex`。顶层 `afterPack` hook 调用唯一的 Swift 编译脚本，先以独立的 App Sandbox 权限签名扩展，再由 electron-builder 封装并签名容器。electron-builder 26 默认跳过 `Contents/PlugIns` 的自动重签；因此扩展必须提前拥有完整的 bundle 签名，不能依赖 Swift linker 签名或 Electron 的继承权限。当前 hook 仅支持容器与扩展均为 ad-hoc 的模式，未来切换 Developer ID 时必须同时升级两者的签名流程。

### 未来启用 Developer ID 与公证所需材料

当前工作流固定使用 ad-hoc 签名，不需要 Apple 账号凭据，也不读取证书或公证 Secrets。后续加入正式签名之前，需要本项目的 Apple Developer 会员资格，以及以下材料：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `MACOS_SIGNING_MODE` | 未来显式选择 `developer-id`，避免默默启用或回退 |
| Variable | `MACOS_SIGNING_IDENTITY` | 完整的 `Developer ID Application: ...` 证书身份名称 |
| Secret | `CSC_LINK` | 包含私钥的本项目 Developer ID `.p12` 文件 Base64 |
| Secret | `CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| Secret | `APPLE_API_KEY_BASE64` | 本项目公证 API key `.p8` 文件 Base64 |
| Secret | `APPLE_API_KEY_ID` | API key ID |
| Secret | `APPLE_API_ISSUER` | API issuer ID |

这些名称是后续配置约定，当前设置它们不会改变签名方式。接入时应只把签名 Secrets 传给 macOS 构建步骤，启用 hardened runtime、强制签名和 Apple 公证；材料缺失、身份不匹配或公证失败必须停止发布，不能降级到 ad-hoc。electron-builder 26 的 `APPLE_API_KEY` 需要 `.p8` 文件路径，应在 runner 临时目录安全解码并始终清理。验包脚本已预留 `--require-notarized`，正式签名发布时应启用该条件，要求 Gatekeeper 接受且 stapled ticket 有效。

## 触发发布

确认目标提交的 CI 通过后，可选择以下任一入口：

1. 推送与项目版本一致的标签，例如 `git tag v0.1.0`，然后 `git push origin v0.1.0`。
2. 在 **Actions → Release installers → Run workflow** 选择目标代码分支，填写不带 `v` 的版本，例如 `0.1.0`。

版本不一致、已有标签指向其他提交、测试失败、任一平台构建失败或缺少签名材料时，发布都会停止。首次手动发布可在所有包完成后由 GitHub 创建版本标签；标签发布使用已存在的标签。

发布流程先执行所需检查，再分别构建 Windows x64、macOS Apple silicon、macOS Intel 和 Android。Mac 构建完成后，`scripts/verify-mac-package.mjs` 对构建目录、最终 ZIP 解压件和 DMG 内的 `.app` 执行严格代码签名、bundle ID、版本与架构检查，并启动 ZIP 中的真实客户端验证桥接和复制路径。每份包的 FinderSync 扩展也必须通过 ID、版本、入口、架构、严格签名及独立沙盒权限检查，确认容器签名未覆盖扩展权限。任一校验失败均阻止安装包上传和发布；JSON 报告保存为 `mac-package-verification-arm64` 或 `mac-package-verification-x64` artifact。

ad-hoc 模式会记录 Gatekeeper 评估结果，完整性及启动检查通过后仍会明确标注未经 Apple 公证。

Mac 验包同时核对构建目录、ZIP 和 DMG 中的应用 ICNS 与共享界面 PNG，要求与本次源码资源字节一致，并在报告中记录 SHA-256，避免图标更新漏入最终包。

构建作业只上传 Actions artifacts；最后一个作业收集完整包，生成清单，创建 draft release，上传并重新下载校验，全部通过后才公开并设为 Latest。因此更新检查不会提前读到缺包的新版本。已公开版本的资产不能由流水线覆盖，应增加版本号再次发布。

## Release 文件

以 `0.1.0` 为例，最终公开 Release 包含：

- `Brclio-0.1.0-windows-x64.exe`：Windows NSIS 安装程序。
- `Brclio-0.1.0-mac-arm64.dmg` 和 `.zip`：Apple silicon Mac。
- `Brclio-0.1.0-mac-x64.dmg` 和 `.zip`：Intel Mac。
- `Brclio-0.1.0-android.apk`：正式签名 APK。
- `SHA256SUMS.txt`：以上六个包的 SHA-256。

macOS 明确使用 `macos-15`（arm64）和 `macos-15-intel`（x64）原生构建，避免 `macos-latest` 迁移造成架构变化。FinderSync 编译需要完整 Xcode 的 macOS SDK、Swift compiler 和 FinderSync framework；两个 Mac 工作流都会先检查所选 Xcode 工具链。Android 使用 JDK 17、SDK 35 和 Build Tools 35.0.0；两个工作流均通过 `android-actions/setup-android@v3` 显式安装 SDK 并设置工具路径，固定使用兼容 JDK 17 的 Command-line Tools 16.0（12266719），不依赖 runner 的预装 `sdkmanager`。

在只存放本次六个安装包的目录中，可手动生成或校验清单：

```sh
node scripts/checksums.mjs release-files --version 0.1.0
node scripts/checksums.mjs release-files --version 0.1.0 --verify
```

缺包、意外多出的安装包、空文件、符号链接、重复清单条目和哈希不一致均会报错。普通构建目录中的 unpacked 子目录和构建日志不计入安装包。

## 发布后验证

检查 [Releases](https://github.com/Brclio/Brclio/releases/latest) 中七个文件均可下载，版本与提交正确，并以清单校验实际下载。然后分别验证 Windows 安装/右键菜单、两种 Mac 架构的安装/Finder 快速操作，以及 Android 安装/分享/文件夹选择。Mac 还需通过浏览器下载最终包再执行首次打开测试，以覆盖下载隔离标记与 Gatekeeper。CI 中隔离目录启动确认了签名完整性与客户端运行，发布后仍需记录每种设备的安装和首次打开结果。

Finder 第一层菜单和工具栏需另行在实际 Finder 中验收：先允许打开容器应用，再由用户启用 FinderSync 扩展，选择文件、文件夹和多个项目检查菜单与实际剪贴板内容，并验证设置变化及关闭扩展后的行为。工具栏还需检查图标、点击后的菜单、无选区时 Finder 提供当前位置的回退，以及无法取得有效位置时的禁用提示。Apple 允许开发测试采用 ad-hoc 签名，但沙盒、扩展注册和 Finder 加载是不同的检查。流水线不会注册或启用系统扩展，报告中的 `finderExtensionRegistrationTested` 和 `finderMenuTested` 因此为 `false`；编译、验签和 Electron smoke 成功不证明 Finder 菜单已可用。

从 v0.1.8 起，复制快捷键也需在真实桌面中单独验收。记录测试平台、应用版本、安装包来源和当前阶段，并分别核对：

- 在前台 Finder／资源管理器选择文件、文件夹和多个项目，按默认快捷键，确认实际剪贴板使用已保存的格式，成功后不切走前台文件窗口。
- 修改组合键、重启软件、制造占用、取消录入和恢复默认，确认新旧绑定、持久化设置与界面状态一致；验证最小化时可复制，以及退出后的绑定释放。
- macOS 首次允许或拒绝 Finder 自动化授权，分别验证复制成功、清晰报错和原剪贴板保留。此权限与 FinderSync 扩展启用、Gatekeeper 首次打开是不同的步骤。
- Windows 11 普通窗口、多窗口和多标签页分别验证当前选区。读取器通过 `QueryActiveShellView` 识别视图；多个页都报告为可见时，使用 `GetGUIThreadInfo` 和 `IsChild` 确认文件列表的焦点归属。无法确认时提示先点击当前页中的选中项目，也可移到独立窗口，不能用后台页的选区代替。
- 无选区、切换到其它应用或选中无法解析的虚拟项目时，确认不会写入错误路径或清空原剪贴板。

单元测试、模拟原生桥接、快捷键注册检查、真实选区复制、安装覆盖及公开资产下载校验是不同的验证阶段。报告仅将实际完成的阶段标为通过，未运行的真实桌面交互应明确记录为待验收。

Windows 自动化验收包含真实资源管理器的两个文件和一个文件夹选区、前台窗口区分与空选区，并在打包客户端中发送默认、自定义及重启后保留的系统快捷键，核对实际剪贴板。Windows 11 客户端的标签页交互仍需单独记录，普通资源管理器窗口测试不能代替该项。

v0.1.8 本地 macOS 候选客户端已在用户允许 Finder 自动化后，由用户实际按下 `Option+P`，确认单个选中文件夹的绝对路径写入系统剪贴板。此结果仅覆盖该本地场景，未证明多选、特殊文件名、其它 Mac 架构或最终公开安装包的相同行为。

软件更新功能依赖公开 Release 的固定资产名称和 `SHA256SUMS.txt`。不要在已发布版本中替换同名安装包；保持 Android 签名连续，并通过新的稳定版本发布更新。

从 v0.1.9 起，还需核验 `https://tools.brclio.com` 的真实正式版本摘要和内置代理下载，确认官网与客户端读取同一版本。管理入口为 `/admin`，只有服务端环境变量和已有私有数据仓库保存维护配置。Cloudflare 服务必须使用 `aiyuechuang@gmail.com` 账号内的单一 `brclio-client-services` Worker；不要依赖本机 Wrangler 当前登录账号推断部署目标。

网络验收分别覆盖系统代理优先、无系统代理时的内置代理、临时关闭、完全退出后恢复开启，以及操作期间禁用开关。真实 Electron 与 Android 进程的状态、单元模拟和代理服务下载是独立证据。TLS 校验错误、错误主机名、不受信 CA、过期或不支持的证书约束必须拒绝，不能因代理联通而放宽证书验证。

内置代理在客户端运行，只有检查与下载更新时才刷新配置并测延。系统代理优先；无系统代理且开关开启时，对全部候选节点做有界并行的真实 HTTPS 探测，选择成功节点中最低延迟者。节点的原始拨号 IP 与用于 TLS 证书、SNI、Host 的 DNS 名称分别验证，不能因使用优选 IP 而关闭证书或主机名校验。每次下载操作固定一条线路，覆盖校验清单、官方跳转和完整安装包；结束与取消后关闭本地监听器和连接。

安装包与 SHA256SUMS.txt 只发布在 GitHub Releases，官网也直链到这些官方文件。Cloudflare 保持免费、单一 Worker，仅提供主页、管理后台、版本摘要与按需配置；旧安装包和清单中转接口返回 410，不能建立代理传输或存储文件。同一 Worker 的备用域名仅开放配置和健康接口，主页与管理入口继续使用 tools.brclio.com。

发布工作流的生产下载门禁从已公开的稳定版本读取 GitHub 元数据，分别在检查与下载开始前刷新生产配置并测延。小 APK 使用共用原生桥和 Node HTTPS；大体积 Windows 安装包使用真实 Electron、原始 updater/router/bridge 与 net.request，完整核对大小、SHA 和清单，不安装下载的历史版本。测试工厂的旧 currentVersion 仅用于触发下载，同时记录实际应用版本。公开步骤依赖两项成功，任何安装包字节均不传入 Cloudflare。三种桌面构建另运行真实 Electron 的离线双 TLS、H1/H2 重定向、节点选择与取消检查；Android 单测、模拟器和最终签名 APK 的升级验证分别记录。安装包构建可与检查并行，publish 仍依赖全部检查、生产门禁和四个构建任务成功。

历史的 Worker 分段与 CPU 失败证据保留作诊断记录，不能用来描述新版客户端的连续下载协议。正式网络验证、最终公开资产校验、覆盖安装及重新启动仍是独立验收阶段。

参考：[Apple FinderSync](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Finder.html)、[Apple 扩展签名、启用与分发](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html)、[electron-builder 26 macOS 签名](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)、[electron-builder 26 公证环境变量](https://www.electron.build/v26/docs/mac/#notarize)、[Apple 代码签名与 Gatekeeper 检查](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)、[GitHub runner 架构与标签](https://github.com/actions/runner-images/blob/main/README.md)、[Android SDK setup v3](https://github.com/android-actions/setup-android/tree/v3)、[Actions artifact 合并下载](https://github.com/actions/upload-artifact/blob/main/docs/MIGRATION.md)、[GitHub CLI release create](https://cli.github.com/manual/gh_release_create)、[Playwright CI](https://playwright.dev/docs/ci-intro)。
