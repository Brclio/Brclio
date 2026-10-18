# 在线更新代理与管理后台

Windows、macOS 和 Android 从 v0.1.9 起包含以下更新代理能力。v0.1.8 及更早的客户端仍沿用其原有更新网络流程；服务端上线与对应客户端安装包的发布分别验证。

Windows、macOS 和 Android 的版本检查、SHA-256 清单与安装包下载共用更新网络策略：检测到系统代理时沿用系统网络；没有系统代理且开关开启时，通过 Cloudflare 服务端的订阅节点获取官方更新；关闭时使用本机网络。

“通用设置 → 版本更新”和“关于 Brclio”均提供“内置更新代理”开关。关闭仅在当前进程有效，窗口重载或 Android Activity 重建保留该进程状态，完全退出并重新启动后默认开启。检查、下载与安装期间暂停切换，避免改变正在进行的更新。关闭内置代理后，系统代理仍然生效。

桌面端使用 Electron 的系统代理与当前默认会话解析实际目标地址，支持 HTTP、SOCKS、PAC 与命令行代理设置。Android 还识别当前活动网络的 VPN、系统 HTTP/PAC 配置与 Java 代理选择器。客户端不会修改操作系统代理设置。VPN/TUN 接管方式受平台检测能力限制，桌面端以系统代理解析结果为准。

## 服务端与数据

部署目录为 `cloudflare/`，项目为 `brclio-client-services`，账号固定为 `cacceff607775c81f667b7a951d4639f`。单一 Worker 通过自定义域名 `https://tools.brclio.com` 提供服务：根路径是 Brclio 介绍与正式版本下载主页，管理后台位于 `/admin`，API 与后台同源。客户端不内置订阅地址、代理 UUID、管理员密码或 GitHub token；六项环境变量均只配置在该 Worker 中，按维护要求使用可在控制台明文查看的 Text 变量。

服务端从订阅读取 VLESS + TLS + WebSocket 节点，通过节点建立到 GitHub 的 TLS 连接并转发响应。更新接口只接受 `Brclio/Brclio` 官方发布信息及发布文件，限制重定向、响应大小与连接时间。转发失败会向客户端返回错误，可以临时关闭内置代理重试。客户端保留安装包大小和 SHA-256 校验，校验成功才进入原生安装流程。

内置代理下载安装包时，每次请求最多 1 MiB，避免单个大文件在 Cloudflare 中持续解密而耗尽 CPU 配额。每段必须返回正确的 `206`、`Content-Range`、长度和强 ETag；后续段使用 `If-Range`，版本或内容发生变化就停止拼接。完整文件仍需通过大小、SHA-256 和各平台安装校验。系统代理与关闭内置代理后的下载保持原生网络流程。主页提供已验证的官方安装包直链。

后台使用管理员登录、带过期时间的签名会话 Cookie 和同源写入校验。订阅配置写入现有私有仓库 `BrclioData/BrclioData`，使用 GitHub 文件 SHA 防止并发覆盖。初始订阅由环境变量提供，后台保存后使用仓库中的最新配置。后台修改订阅不需要重新打包客户端。

所有部署凭据使用 Cloudflare 控制台维护的服务端 Text 环境变量；`keep_vars = true` 保留控制台配置，变量值不会返回给客户端。具体变量、配置文件路径和部署步骤见 [客户端服务部署说明](client-services.md) 和 [服务端说明](../cloudflare/README.md)。源码、安装包、测试报告和日志中不得保存凭据值。

## 验证

```sh
npm test
npm run test:hosts
npm run test:proxy-ui
npm run test:updates
npm --prefix cloudflare ci
npm run test:cloudflare
npm --prefix cloudflare run check
```

Android 原生验证需要 JDK 17 和 Android SDK 35：

```sh
cd android
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

后端部署、后端实际代理下载、各平台构建和已安装客户端更新是不同的验证阶段。后端上线不代表新客户端安装包已经发布；旧客户端需要升级到包含此代理策略的新安装包才能使用该功能。
