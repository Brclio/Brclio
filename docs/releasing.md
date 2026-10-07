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

当前 macOS 安装包没有 Developer ID 签名和 Apple notarization，Windows 安装包也没有 Authenticode 签名。首次启动可能触发系统安全确认。GitHub SHA-256 清单用于检查下载是否完整，不能替代开发者代码签名。

## 触发发布

确认目标提交的 CI 通过后，可选择以下任一入口：

1. 推送与项目版本一致的标签，例如 `git tag v0.1.0`，然后 `git push origin v0.1.0`。
2. 在 **Actions → Release installers → Run workflow** 选择目标代码分支，填写不带 `v` 的版本，例如 `0.1.0`。

版本不一致、已有标签指向其他提交、测试失败、任一平台构建失败或缺少签名材料时，发布都会停止。首次手动发布可在所有包完成后由 GitHub 创建版本标签；标签发布使用已存在的标签。

发布流程先执行所需检查，再分别构建 Windows x64、macOS Apple silicon、macOS Intel 和 Android。构建作业只上传 Actions artifacts；最后一个作业收集完整包，生成清单，创建 draft release，上传并重新下载校验，全部通过后才公开并设为 Latest。因此更新检查不会提前读到缺包的新版本。已公开版本的资产不能由流水线覆盖，应增加版本号再次发布。

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

检查 [Releases](https://github.com/Brclio/Brclio/releases/latest) 中七个文件均可下载，版本与提交正确，并以清单校验实际下载。然后分别验证 Windows 安装/右键菜单、两种 Mac 架构的安装/Finder 快速操作，以及 Android 安装/分享/文件夹选择。流水线构建成功不等同于这些设备验证已完成。

软件更新功能依赖公开 Release 的固定资产名称和 `SHA256SUMS.txt`。不要在已发布版本中替换同名安装包；保持 Android 签名连续，并通过新的稳定版本发布更新。

参考：[GitHub runner 架构与标签](https://github.com/actions/runner-images/blob/main/README.md)、[Android SDK setup v3](https://github.com/android-actions/setup-android/tree/v3)、[Actions artifact 合并下载](https://github.com/actions/upload-artifact/blob/main/docs/MIGRATION.md)、[GitHub CLI release create](https://cli.github.com/manual/gh_release_create)、[Playwright CI](https://playwright.dev/docs/ci-intro)。
