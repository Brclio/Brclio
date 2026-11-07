# Brclio 下载器

macOS 打开对应芯片的 DMG，把 **Brclio Downloader** 拖入“应用程序”，然后双击运行。Windows x64 运行 EXE 安装下载器。

macOS 将 Brclio 本体安装到系统应用程序目录 `/Applications/Brclio.app`，并从这个位置判断版本和打开应用。若旧版下载器曾安装到 `~/Applications/Brclio.app`，请先退出那份 Brclio，再运行新版下载器。新版会保留用户目录中的旧副本。两份 Brclio 使用同一个应用标识，通常会读取同一套本地设置。系统目录不可写时，下载器会提示所需权限。

下载器启动、点击“下载并安装 Brclio”“升级下载器”或“重新尝试”时，都会重新检查当前请求目标的系统代理设置。检测到系统 HTTP、HTTPS、SOCKS 或 PAC 指定的代理时，沿用电脑的代理。系统代理连接失败时会报告错误，重试时重新检测。

如果系统对下载目标使用直连，下载器会刷新订阅，并发探测候选节点到 GitHub 的 HTTPS 延迟，选用成功节点中延迟最低的一条。检查版本、下载及网络重试都会重新选线。代理识别依据系统或 Chromium 对目标地址返回的代理配置；仅打开代理软件而未启用系统代理，或仅启用透明 TUN 的情况，可能仍显示内置代理。

启动时按设置自动检查下载器和 Brclio，下载安装包并校验 SHA-256 后安装并打开 Brclio。本机已有相同或更高版本时直接打开。两个手动按钮分别用于下载最新版 Brclio 和检查下载器自身的升级。

“自动更新下载器自身”默认开启。关闭后，启动时跳过自身版本检查，仍会下载最新稳定版 Brclio。需要时可手动点击“升级下载器”。这个选择保存在下载器自己的配置目录内。

下载器使用独立的应用标识 `com.brclio.downloader`。从仓库根目录执行以下命令，可以启动开发版或生成桌面安装包。

```sh
npm ci
npx electron bootstrap
bash bootstrap/tools/build-mac.sh arm64
bash bootstrap/tools/build-mac.sh x64
npx electron-builder --config bootstrap/electron-builder.cjs --win --x64 --publish never
```

在对应平台运行构建命令。安装包输出在 `release/downloader/`。Mac 安装包使用项目现有的 ad-hoc 签名，第一次打开下载器时 Gatekeeper 可能要求手动允许打开。Windows 使用当前用户的 NSIS 安装程序。

## 独立发布

1. 修改 `bootstrap/package.json` 中的版本，例如 `1.0.1`。运行 `node --test bootstrap/*.test.cjs`。
2. 将对应提交打上 `downloader-v1.0.1` 标签并推送，触发 **Release Brclio Downloader**。该工作流构建 Windows x64、Mac arm64 和 Mac x64 三个安装包，并生成 `SHA256SUMS.txt`。
3. 工作流将安装包放入 `downloader-v1.0.1` 的 GitHub prerelease，下载并复核后更新 `downloader-stable` 中的 `latest.json`。两个发布都设置 `--latest=false`，Brclio 客户端继续使用原有的稳定版入口。

版本标签上的安装包在公开后保持固定。`downloader-stable` 是可更新的索引，不包含安装程序。若仓库强制所有已发布附件不可修改，需要先为这个索引选择可写的发布位置。已有下载器每次启动都读取索引，自身版本已经最新或索引尚未发布时，继续通过 Brclio 的正式版入口获取客户端。
