# 在线更新代理与管理后台

Windows、macOS 和 Android 从 v0.1.9 起支持客户端内置更新代理；v0.1.13 统一系统代理优先、每次重新选点及最多 10 次自动重试。对应安装包正式发布前，服务端上线不代表旧客户端已支持该能力。主页依据实际正式版本元数据展示支持状态。

## 客户端网络策略

检测到系统代理时优先沿用系统网络；没有系统代理且开关开启时，客户端刷新订阅节点配置并运行临时本地 CONNECT → VLESS WSS 桥；关闭时使用本机网络。GitHub 的元数据、校验清单和安装包都由客户端的原生 TLS 下载，Cloudflare 只提供配置，不传输或存放安装包。

“通用设置 → 版本更新”和“关于 Brclio”提供“内置更新代理”开关。开关状态仅在当前进程有效，完全退出并重启后默认开启。检查、下载与安装期间暂停切换，避免改变当前操作。关闭内置代理后系统代理仍然生效。

桌面端使用 Electron 系统代理解析，覆盖 HTTP、SOCKS、PAC 与命令行代理设置；Android 还识别活动 VPN、系统 HTTP/PAC 与 Java 代理选择器。客户端不会修改操作系统代理配置。桌面 VPN/TUN 检测受平台解析能力限制。

v0.1.13 按每次操作检测到的网络环境选择路线：检测到系统代理时，更新和自动重试继续使用系统代理；无系统代理且内置代理开启时，每次新尝试都重新读取后台当前订阅配置、抓取订阅并重新测速选点。关闭内置代理且无系统代理时使用直连。v0.1.12 的系统代理故障后直连回退由这套规则替代。旧客户端无法获取更新时，需先手动安装新版。

需要内置代理时，每次检查、下载及自动重试都向 `/api/client/update-proxy` 请求最新私库配置与订阅，不沿用上次节点缓存。最多 16 个有效候选全部并发探测原生 HTTPS `HEAD https://github.com/robots.txt`，单点 4 秒、整批 8 秒，在成功路线中选择本机端到端延迟最低者。一次尝试锁定路线；下载中断后清理未完成文件，下一次尝试重新获取清单并从头下载、完整校验。

连接、订阅获取、无可用节点和可恢复下载中断由客户端统一重试：首次尝试失败后最多再自动重试 10 次，共最多 11 次尝试。成功立即停止重试；次数用完后，设置与关于窗口提示用户自行点击“重新检查”或“重新下载”。手动操作重新计数。重试等待逐步增加且有上限；检查每次有独立超时，下载仍受 10 分钟总时限约束，达到总时限可提前停止。取消、证书、地址、格式、完整性校验及本地文件错误直接停止，安装动作不会自动重复执行。

节点配置采用版本 1、最多 32 KiB，只包含 UUID、TLS DNS 名称、端口、路径、SNI、HTTP Host 和 `dialAddress`。不同优选 IP 线路完整保留，超过 16 个有效候选会明确报不支持，不静默截断。DNS 认证名称保持 `host == servername == wsHost`；实际 TCP 连接可使用独立的规范公网 IPv4 或严格公网 DNS `dialAddress`。拒私网、回环、链路本地、保留地址、本地名称与 IPv6。优选 IP 不改变证书认证名称。

外层 WSS 和内层 GitHub HTTPS 均使用原生证书/主机名验证，不接受跳过证书校验的订阅设置。本地监听只存在于更新操作期间，只允许官方 GitHub/CDN 的 443 CONNECT。桌面使用 Electron 原生 `net.request` 读取重定向响应，再交给路由逐跳验证 GitHub/CDN 地址；不会自动跟随未经验证的跳转。下载保留官方重定向白名单、长度、完整 SHA-256 与平台安装校验，通过后才进行覆盖安装和自动打开。桌面检查每次默认 20 秒、Android 每次 60 秒；下载总计 10 分钟，桌面空闲 45 秒；停止后清理当前网络和临时文件。

## 服务端与维护

单一 Worker `brclio-client-services` 固定在账号 `cacceff607775c81f667b7a951d4639f`，主域名 `https://tools.brclio.com`，后台 `/admin`。主页安装包与清单链接直达已验证的官方 GitHub Release；旧 `/api/update` 文件请求直接返回 410 升级提示。

同一 Worker 的固定备用引导域名 `brclio-client-services.aiyuechuang.workers.dev` 仅开放 GET 配置与健康检查。客户端只在主入口网络失败或收到明确 Cloudflare 质询时尝试备用入口，不将 429/502 变成绕过限流的重试。备用入口不开放后台，未关闭整域防护。

节点 UUID 等连接参数是客户端运行内置代理所必需，可从客户端或配置响应提取。订阅原链接、管理员密码、GitHub App 私钥、短期安装令牌和会话密钥仍只保留在服务端，不下发完整订阅。

后台使用签名会话 Cookie、同源 Origin 与 CSRF 校验。全局代理配置属于程序资料，固定存放在 `GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData` 的 `config/update-proxy.json`，带文件 SHA 防止并发覆盖。服务端使用仅限该仓库的 GitHub App 短期安装令牌读写；不会把全局配置迁入账号库或在缺少配置时回退账号库。`BrclioData/BrclioUserData` 仅保存账号及用户所属数据，包括个人偏好。初始订阅来自环境变量，保存后优先使用程序资料库最新配置。后台修改无需重打包客户端。

用户要求控制台明文维护，因此六项部署环境变量使用 Cloudflare Text 类型，`keep_vars = true` 保留控制台设置。源码、安装包、测试报告和日志不得保存其值。具体名称与部署步骤见 [客户端服务说明](client-services.md) 和 [后端契约](../cloudflare/README.md)。

## 验证

```sh
npm test
npm run test:hosts
npm run test:proxy-ui
npm run test:native-proxy
npm run test:updates
npm run test:system-proxy-live
npm --prefix cloudflare ci
npm run test:cloudflare
npm --prefix cloudflare run check
```

Android 原生验证需要 JDK 17 和 Android SDK 35：

```sh
cd android
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

正式发布生产 gate 用 Node 原生传输下载完整小 APK，再用真实 Electron、原始 updater/router/bridge 下载完整大体积 Windows 安装包，分别核对官方元数据/清单 SHA；不安装下载的历史版本。真实 Electron 工厂中的旧 currentVersion 仅用于触发传输验收，报告同时记录实际应用版本。Worker 返回 410 不能算下载通过。发布记录分别保留配置服务部署、各平台原生传输、签名构建、公开 Release 和真实覆盖/自动打开结果。

另用独立临时 Electron 进程检查主机的真实系统代理解析与正式版本检查，不覆盖系统设置或默认会话代理、不下载或安装程序。报告区分未检测到代理、系统代理正常及系统代理失败后重试耗尽；没有系统代理的 CI 主机不能据此声称复现了代理故障。自动重试预算与不可重试场景另由自动化测试验证。
