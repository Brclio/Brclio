# Brclio 客户端服务

`cloudflare/` 是 Brclio 客户端共用的服务端与管理后台。当前只有已经实现的「更新与网络」模块：为客户端提供官方版本检查、安装包下载代理，以及管理员维护代理订阅的能力。后台概览不会展示未实现的功能，也不将配置状态当作代理健康检查。

## 部署边界

部署为单一 Cloudflare Worker，项目名 `brclio-client-services`，账号固定为 `cacceff607775c81f667b7a951d4639f`。后台 `/admin` 和 API 使用该账号确认后的同一个 HTTPS 自定义域名，不需要 Pages 或第二个服务。

仓库分支可通过正确账号的 Worker Settings → Builds 连接；构建根目录选择 `cloudflare/`，构建命令使用 `npm ci && npm test`，部署命令由该账号的 Builds 执行 `npx wrangler deploy`。Wrangler 配置固定了账号和项目名。当前域名是否已绑定、是否完成部署，应以该账号实际状态与在线验证为准。

运行时凭据全部配置为该 Worker 的加密 Secret：`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`GITHUB_TOKEN`、`GITHUB_DATA_REPOSITORY`、`PROXY_SUBSCRIPTION_URL`。源码、构建包和日志中不包含这些值。

## 已有接口

- `GET /api/health`：通用服务标识与基本可用性。
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
npm --prefix cloudflare run smoke -- https://已确认的服务域名 --large
```

验证脚本通过真实 VLESS + TLS + WebSocket 代理获取发布元数据、SHA256SUMS 清单与完整安装包，再核对大小和 SHA-256；不会保存或执行安装包。

后端部署、真实代理下载、新客户端构建及安装包发布是不同阶段。提交后端源码分支和配置 GitHub Builds 不代表新客户端安装包已经发布。TLS 实现的范围与限制、完整环境配置和源码结构见 [服务端说明](../cloudflare/README.md)。
