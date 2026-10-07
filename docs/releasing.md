# 发布 Brclio

仓库为 [Brclio/Brclio](https://github.com/Brclio/Brclio)。`main` 推送与面向 `main` 的 PR 会执行 Node 22 单元测试、真实 Chromium 界面/剪贴板测试、原生桥接契约测试，以及 Android 单元测试和 lint。浏览器测试使用 Playwright 安装的 Chromium，不依赖开发机上的 Chrome 路径。

## 版本与签名

发布前同步修改 `package.json`、`package-lock.json` 和 `android/app/build.gradle` 的版本。当前流水线接受 `X.Y.Z` 稳定版本，Android `versionCode` 每次发布必须递增。所有安装包都从同一个提交构建。

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 配置以下四个仓库 Secret：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 正式发布 keystore 文件的 Base64 内容 |
| `ANDROID_SIGNING_STORE_PASSWORD` | keystore 密码 |
| `ANDROID_SIGNING_KEY_ALIAS` | 签名 key 的 alias |
| `ANDROID_SIGNING_KEY_PASSWORD` | 签名 key 的密码 |

同一 Android 应用后续更新必须继续使用同一把签名 key；妥善离线备份 keystore 和密码。流水线缺少任何签名 Secret 会失败，绝不发布 unsigned 或 debug APK。签名文件只写入临时目录，并在作业结束时删除。

macOS 默认采用完整的 ad-hoc 签名，以验证应用及嵌套组件的完整性；该模式关闭 hardened runtime，尚未使用 Developer ID 和 Apple notarization。浏览器下载后的首次启动仍可能需要在系统设置的“隐私与安全性”中允许打开。Windows 安装包尚未使用 Authenticode 签名。SHA-256 清单用于检查下载是否完整，代码签名完整性、运行能力和 Gatekeeper 信任分别验收。

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

发布流程先执行所需检查，再分别构建 Windows x64、macOS Apple silicon、macOS Intel 和 Android。Mac 构建完成后，`scripts/verify-mac-package.mjs` 对构建目录、最终 ZIP 解压件和 DMG 内的 `.app` 执行严格代码签名、bundle ID、版本与架构检查，并启动 ZIP 中的真实客户端验证桥接和复制路径。任一校验失败均阻止安装包上传和发布；JSON 报告保存为 `mac-package-verification-arm64` 或 `mac-package-verification-x64` artifact。

ad-hoc 模式会记录 Gatekeeper 评估结果，完整性及启动检查通过后仍会明确标注未经 Apple 公证。

构建作业只上传 Actions artifacts；最后一个作业收集完整包，生成清单，创建 draft release，上传并重新下载校验，全部通过后才公开并设为 Latest。因此更新检查不会提前读到缺包的新版本。已公开版本的资产不能由流水线覆盖，应增加版本号再次发布。

## Release 文件

以 `0.1.0` 为例，最终公开 Release 包含：

- `Brclio-0.1.0-windows-x64.exe`：Windows NSIS 安装程序。
- `Brclio-0.1.0-mac-arm64.dmg` 和 `.zip`：Apple silicon Mac。
- `Brclio-0.1.0-mac-x64.dmg` 和 `.zip`：Intel Mac。
- `Brclio-0.1.0-android.apk`：正式签名 APK。
- `SHA256SUMS.txt`：以上六个包的 SHA-256。

macOS 明确使用 `macos-15`（arm64）和 `macos-15-intel`（x64）原生构建，避免 `macos-latest` 迁移造成架构变化。Android 使用 JDK 17、SDK 35 和 Build Tools 35.0.0；两个工作流均通过 `android-actions/setup-android@v3` 显式安装 SDK 并设置工具路径，固定使用兼容 JDK 17 的 Command-line Tools 16.0（12266719），不依赖 runner 的预装 `sdkmanager`。

在只存放本次六个安装包的目录中，可手动生成或校验清单：

```sh
node scripts/checksums.mjs release-files --version 0.1.0
node scripts/checksums.mjs release-files --version 0.1.0 --verify
```

缺包、意外多出的安装包、空文件、符号链接、重复清单条目和哈希不一致均会报错。普通构建目录中的 unpacked 子目录和构建日志不计入安装包。

## 发布后验证

检查 [Releases](https://github.com/Brclio/Brclio/releases/latest) 中七个文件均可下载，版本与提交正确，并以清单校验实际下载。然后分别验证 Windows 安装/右键菜单、两种 Mac 架构的安装/Finder 快速操作，以及 Android 安装/分享/文件夹选择。Mac 还需通过浏览器下载最终包再执行首次打开测试，以覆盖下载隔离标记与 Gatekeeper。CI 中隔离目录启动确认了签名完整性与客户端运行，发布后仍需记录每种设备的安装和首次打开结果。

软件更新功能依赖公开 Release 的固定资产名称和 `SHA256SUMS.txt`。不要在已发布版本中替换同名安装包；保持 Android 签名连续，并通过新的稳定版本发布更新。

参考：[electron-builder 26 macOS 签名](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)、[electron-builder 26 公证环境变量](https://www.electron.build/v26/docs/mac/#notarize)、[Apple 代码签名与 Gatekeeper 检查](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)、[GitHub runner 架构与标签](https://github.com/actions/runner-images/blob/main/README.md)、[Android SDK setup v3](https://github.com/android-actions/setup-android/tree/v3)、[Actions artifact 合并下载](https://github.com/actions/upload-artifact/blob/main/docs/MIGRATION.md)、[GitHub CLI release create](https://cli.github.com/manual/gh_release_create)、[Playwright CI](https://playwright.dev/docs/ci-intro)。
