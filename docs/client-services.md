# Brclio 客户端服务

`cloudflare/` 提供公开下载主页、管理员后台和客户端所需的代理配置。当前只有「更新与网络」模块。内置代理在客户端本地运行；安装包与 SHA256SUMS 清单只保存在 GitHub，由客户端直接通过代理连接 GitHub 下载。Cloudflare 不保存或中转安装包。

## 部署

单一 Worker 为 `brclio-client-services`，账号固定为 `cacceff607775c81f667b7a951d4639f`。主入口 `https://tools.brclio.com` 的根路径介绍 Brclio、提供正式 GitHub 下载链接，后台为 `/admin`。不需要 Pages、第二个 Worker 或付费存储。

同一 Worker 的生产别名 `https://brclio-client-services.aiyuechuang.workers.dev` 仅作为配置引导备用入口：只允许 GET `/api/client/update-proxy` 和 GET `/api/health`，主页、后台、登录和其它路径全部 404。先部署此限制并保持 `workers_dev = false`，再由正确账号控制台启用生产别名，验证后将配置持久化为 true；预览入口保持关闭。自定义域名上已确认的 Bot Fight Mode 质询不通过关闭整区防护解决。备用域名在各网络中的可达性需实际验证。

GitHub Builds 构建根目录为 `cloudflare`，构建命令 `npm ci && npm test`，部署命令由正确账号执行 `npx wrangler deploy`。本地 CLI 若登录其它账号，不应用于部署。

用户要求六项环境变量在控制台可明文维护，因此使用该 Worker 的 Text 变量：`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`GITHUB_TOKEN`、`GITHUB_DATA_REPOSITORY`、`PROXY_SUBSCRIPTION_URL`。`keep_vars = true` 保留控制台值；源码、公开 JSON 和日志不得包含这些值。

## 接口

- `GET /`、`GET /api/releases/latest`：经过校验的官方稳定版本介绍与 GitHub 下载直链。
- `GET /api/health`：非敏感服务状态。
- `GET /api/client/update-proxy`：每次操作都刷新私库配置与订阅，返回版本为 1 的固定节点配置，最多 16 条、32 KiB、`Cache-Control: no-store`，每 IP 每分钟 30 次。
- `GET /api/update?url=...`：仅保留官方 latest 元数据兼容；安装包和校验清单请求在读取代理配置前返回 410 升级提示，不传输文件。
- `POST /api/admin/login`、`POST /api/admin/logout`：同源管理员会话。
- `GET /api/admin/overview`：实际模块与配置状态，不包含订阅链接，也不声称代理健康。
- `GET /api/admin/config`、`PUT /api/admin/config`：管理员维护订阅，签名 Cookie、Origin、CSRF 和 GitHub 文件 SHA 防并发覆盖。

订阅初始值来自环境，后台保存后以私库 `config/update-proxy.json` 为准。客户端每次检查/下载各取一次最新配置，无需重新打包客户端即可维护订阅。节点的 UUID、连接地址等是客户端使用代理所必需，能从客户端/接口提取；订阅原链接、管理密码、PAT 与会话密钥不下发。

## 验证

```sh
npm --prefix cloudflare ci
npm --prefix cloudflare test
npm --prefix cloudflare run check
npm --prefix cloudflare run bundle:browser
```

真实下载 gate 需要根目录的生产依赖：

```sh
npm ci --omit=dev
npm --prefix cloudflare run smoke -- https://tools.brclio.com
npm --prefix cloudflare run smoke -- https://tools.brclio.com --large
```

脚本分别在检查与下载操作前刷新配置、探测全部节点选最快，复用桌面本地 CONNECT/WSS 桥，再以 Node 原生 TLS 从 GitHub 读取元数据、清单和完整安装包，验证大小及双重 SHA-256。不会保存、执行安装包，也不会让文件经过 Worker。正式发布 gate 同时验证小包与大于 100 MiB 的包；三个桌面平台构建另跑真实 Electron 双 TLS/WSS 连续流夹具。

后端部署、原生代理实际下载、签名构建、公开发布与已安装客户端覆盖/自动打开分别验收。详细契约和安全边界见 [服务端说明](../cloudflare/README.md) 与 [更新代理说明](update-proxy.md)。
