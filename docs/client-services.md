# Brclio 客户端服务

`cloudflare/` 是 Brclio 客户端共用的服务端、公开下载主页与管理后台。当前只有已经实现的「更新与网络」模块：为客户端提供官方版本检查、安装包下载代理，以及管理员维护代理订阅的能力。后台概览不会展示未实现的功能，也不将配置状态当作代理健康检查。

## 部署边界

部署为单一 Cloudflare Worker，项目名 `brclio-client-services`，账号固定为 `cacceff607775c81f667b7a951d4639f`。已确认的自定义域名为 `https://tools.brclio.com`，根路径提供 Brclio 介绍与正式安装包下载主页，管理后台为 `https://tools.brclio.com/admin`；后台和 API 同源，不需要 Pages 或第二个服务。Wrangler 固定该自定义域名路由，并关闭 workers.dev 入口。

仓库分支可通过正确账号的 Worker Settings → Builds 连接；构建根目录选择 `cloudflare/`，构建命令使用 `npm ci && npm test`，部署命令由该账号的 Builds 执行 `npx wrangler deploy`。Wrangler 配置固定了账号和项目名。当前域名是否已绑定、是否完成部署，应以该账号实际状态与在线验证为准。

按用户的维护要求，运行时凭据配置为该 Worker 的普通 Text 环境变量，可在 Cloudflare 控制台明文查看；`keep_vars = true` 会在后续部署时保留这些值：`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`GITHUB_TOKEN`、`GITHUB_DATA_REPOSITORY`、`PROXY_SUBSCRIPTION_URL`。源码、构建包和日志中不包含这些值。

## 已有接口

- `GET /`：介绍 Brclio 并下载当前正式发布的客户端。
- `GET /api/health`：通用服务标识与基本可用性。
- `GET /api/releases/latest`：经过校验的官方稳定版摘要与安装包、校验清单地址。
- `GET /api/update?url=...`：只允许 `Brclio/Brclio` 官方版本元数据与发布文件。
- `POST /api/admin/login`、`POST /api/admin/logout`：共用管理员会话。
- `GET /api/admin/overview`：已登录管理员的服务概览与实际模块配置状态。
- `GET /api/admin/config`、`PUT /api/admin/config`：保持现有订阅配置接口兼容。

管理员会话使用带过期时间的签名 Cookie；写入请求还校验同源 Origin 与 CSRF token。订阅配置保存在现有私有 GitHub 数据仓库的 `config/update-proxy.json`，通过文件 SHA 防止并发覆盖。后台保存订阅后不需要重新打包客户端。

## 验证与发布状态

```sh
npm --prefix cloudflare ci
npm --prefix cloudflare test
npm --prefix cloudflare run check
npm --prefix cloudflare run bundle:browser
```

在线验证需传入已确认的服务域名：

```sh
npm --prefix cloudflare run smoke -- https://tools.brclio.com --large
```

验证脚本通过真实 VLESS + TLS + WebSocket 代理获取发布元数据、SHA256SUMS 清单与完整安装包，再核对大小和 SHA-256；不会保存或执行安装包。

后端部署、真实代理下载、新客户端构建及安装包发布是不同阶段。提交后端源码分支和配置 GitHub Builds 不代表新客户端安装包已经发布。TLS 实现的范围与限制、完整环境配置和源码结构见 [服务端说明](../cloudflare/README.md)。

公开主页通过 `GET /api/releases/latest` 获取经过校验的官方正式版本摘要：版本号、发布时间、GitHub 发布页、各平台安装包与 SHA256SUMS 地址。草稿、预发布、其它仓库与不一致的下载地址会被拒绝；下载通过同源 `/api/update` 转发。主页不把开发分支中的更新代理称为已发布客户端功能。
