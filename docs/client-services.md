# Brclio 客户端服务

`cloudflare/` 提供公开下载主页、用户账号、管理员后台和客户端所需的代理配置。账号与更新服务共用同一 Worker。账号及用户所属数据存入私库 `BrclioData/BrclioUserData`，程序全局资料存入私库 `BrclioData/BrclioData`。内置更新代理在客户端本地运行；安装包与 SHA256SUMS 清单只保存在 GitHub，由客户端直接通过代理连接 GitHub 下载。Cloudflare 不保存或中转安装包。

## 部署

单一 Worker 为 `brclio-client-services`，账号固定为 `cacceff607775c81f667b7a951d4639f`。主入口 `https://tools.brclio.com` 的根路径介绍 Brclio、提供正式 GitHub 下载链接，用户账号为 `/account`，管理员后台为 `/admin`。不需要 Pages、第二个 Worker 或付费存储。

同一 Worker 的生产别名 `https://brclio-client-services.aiyuechuang.workers.dev` 仅作为配置引导备用入口：只允许 GET `/api/client/update-proxy` 和 GET `/api/health`，主页、后台、登录和其它路径全部 404。已先部署该限制，再在正确账号控制台启用生产别名，配置持久化为 `workers_dev = true`；预览入口保持关闭。自定义域名上已确认的 Bot Fight Mode 质询不通过关闭整区防护解决。备用域名在各网络中的可达性需实际验证。

GitHub Builds 构建根目录为 `cloudflare`，构建命令 `npm ci && npm test`，部署命令由正确账号执行 `npm run deploy`。本地 CLI 若登录其它账号，不应用于部署。

Wrangler 在部署前执行 `npm run bundle:browser`，把原 `src/entry.js` 的 JavaScript、HTML/TXT 图预编译为 `dist/browser/brclio-client-services.mjs`。构建检查单输出、默认导出和仅运行时内建依赖；`no_bundle = true`、`find_additional_modules = false`、`upload_source_maps = false` 保证实际只上传这一个产物。真实 CLI 隔离验收中，八模块即使关闭 map 仍在激活后失败；同一业务的单文件连续两次上传与激活均健康，修复候选的新字节产物也通过重复部署。平台内部失效机制尚未确证，不能把 source map 认作唯一原因。该构建配置也适用于直接调用 Wrangler。

`npm run deploy` 的 `postdeploy` 门禁只向正式入口执行五项匿名 GET：首页、健康检查、匿名账号会话、固定客户端配置和正式版本摘要。门禁校验响应大小、内容类型及数据结构，并确认现有 Google/邮箱入口可用；不携带 Cookie 或 Authorization，不登录或写入用户数据。五项检查共享 60 秒总时限，每次请求最多 15 秒，暂态失败的接口最多尝试三次；任何必需项仍失败即退出 1。上传先于门禁完成，失败时线上已上传的版本仍需维护者复核和恢复。直接运行 Wrangler 后可在 `cloudflare/` 执行 `npm run verify:deployment` 补做同一门禁。输出仅包含固定接口标签、状态、错误枚举、登录入口可用布尔值及公开版本号，不输出配置节点、URL、响应正文、请求头或凭据。

同名重建 Worker 后，旧 GitHub Builds 连接及历史属于原 Worker 身份，需重新连接当前身份并核验实际部署；源码修改本身不代表控制台连接已经恢复。

控制台保留现有 `ADMIN_EMAIL`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`PROXY_SUBSCRIPTION_URL` 配置。账号库为 `GITHUB_DATA_REPOSITORY=BrclioData/BrclioUserData`，程序资料库为 `GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData`；两者独立配置，全局配置缺失时不能回退账号库。GitHub 凭据改为 `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID` 和 Secret `GITHUB_APP_PRIVATE_KEY`，不再读取个人 `GITHUB_TOKEN`。`keep_vars = true` 保留控制台值；源码、公开 JSON 和日志不得包含秘密值。初次切换前先完成停写、迁移核验和 App 配置，不能提前让线上指向空库。

## 用户账号配置

在同一 Worker 配置以下变量，禁止把实际凭据写入源码、公开仓库、发布说明或安装包：

| 变量 | 用途与配置 |
| --- | --- |
| `SMTP_EMAIL` | 发件 Gmail 邮箱；验证码发件人和 SMTP 登录账号使用同一地址。 |
| `SMTP_APP_PASSWORD` | 该 Gmail 账号的应用专用密码，建议使用 Worker Secret；发送前自动去掉排版空格。 |
| `GOOGLE_CLIENT_ID` | Google Auth Platform 创建的 Web application OAuth 客户端 ID。 |
| `GOOGLE_CLIENT_SECRET` | 上述 OAuth 客户端的密钥，建议使用 Worker Secret。 |
| `SESSION_SECRET` | 复用已有至少 32 字符的随机会话密钥；用户会话与管理员会话使用不同的签名命名空间。 |
| `GITHUB_DATA_REPOSITORY` | `BrclioData/BrclioUserData`；服务会检查仓库为 private。 |
| `GITHUB_PROGRAM_DATA_REPOSITORY` | `BrclioData/BrclioData`；全局配置 `config/update-proxy.json` 的独立来源。 |
| `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID` | 安装到 BrclioData 组织的 GitHub App ID 与安装 ID；按所有者选择 All repositories，Contents 读写、Metadata 只读。每次请求仍仅换取目标单仓库的短期令牌。 |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App 下载的 PEM 私钥，配置为 Worker Secret。服务签发 RS256 JWT 换取单仓库短期安装令牌，提前续期；不使用个人 Token，也不把 App 凭据交给各程序。 |

Google OAuth 的 Authorized JavaScript origins 使用 `https://tools.brclio.com`，Authorized redirect URIs 使用 `https://tools.brclio.com/api/account/google/callback`。无需为 Electron 或 Android 再创建内嵌 WebView OAuth 客户端。两者在系统浏览器打开服务端设备登录链接，网页完成 Google 登录后由用户确认授权，原生端凭一次性随机验证证明换取自身会话；请求五分钟过期，界面可取消。Google 客户端密钥只用于服务端交换授权码；ID token 通过 Google 公钥、签发者、受众、有效期、nonce 与已验证邮箱校验。

发信使用 Worker 原生 TLS Socket 连接 `smtp.gmail.com:465`，以 Gmail 应用专用密码认证。注册邮件验证码为 6 位数字，10 分钟有效、60 秒重发间隔，错误验证最多 5 次，并有每 IP 及全局发送限流。邮箱已注册时返回 `409 EMAIL_EXISTS`，提示直接登录并到账号设置完善资料。SMTP 最终接受邮件与用户邮箱实际收件是不同证据，发布验收需分别记录。

用户目录在首次写入账号记录时创建，无需额外存储服务：

```text
users/
  _index.json
  <用户ID>/
    profile.json      # 账号名、邮箱、登录提供方和创建时间
    credentials.json  # 明文密码、验证用密码哈希、Google 身份关联、会话摘要和登录限流记录
    data.json         # 旧账号已有时保留；新路径缺失才只读回退
    apps/
      brclio/data.json  # 复制格式偏好、revision、更新时间
      miniapp/data.json # 小程序数据、revision、更新时间
```

JSON 档案和偏好可在私库中直接阅读。按产品所有者明确要求，应用账号密码以 `passwordPlaintext` 明文保存，注册、成功密码登录和设置密码均同步写入；验证仍使用 PBKDF2-SHA256、100000 次迭代及每用户随机盐。旧哈希无法还原明文，历史账号在下次成功密码登录或设置密码后补写；Google 用户未设置密码时没有明文密码。明文密码只写入私库凭据文件，不返回账号 API、日志或客户端。仓库及其 Git 历史的读权限可直接看到密码。验证码摘要绑定邮箱与服务端密钥，会话索引仅保存随机标识摘要。账号索引与个人文件在同一次 Git 提交写入，使用非强制 ref 更新防并发覆盖，冲突时重新读取后重试。

Google 的已验证邮箱与现有账号一致时复用原用户 ID、个人目录和密码，增加 Google 身份关联。账号设置允许修改昵称与唯一账号名；已有密码必须提供当前密码，Google 首次设密码可使用当前已登录会话。改密保留当前会话，撤销其他会话及尚未消费的已批准客户端登录请求。

网页登录使用七天 HttpOnly、Secure、SameSite=Lax Cookie，写操作要求同源和 CSRF；原生端使用三十天 Bearer，会话仅保存在应用私有本机配置。原生账号桥仅允许固定 `https://tools.brclio.com/api/account/*` 操作，附加 `X-Brclio-Client: native` 且不发送 Origin。渲染层不能选择远程来源或读取 Bearer。Google 登录始终交给系统浏览器。账号服务不经过内置更新代理，也不向备用 workers.dev 域名增加账号入口。

可跨设备手动同步的字段仅有 `pathMode`、`quoteMode`、`separator`、`trailingSlash` 和 `joinWith`。文件内容、实际路径、`basePath`、快捷键和开机启动设置不上传。复制路径与本机偏好功能无需登录。

## 接口

- `GET /`、`GET /api/releases/latest`：经过校验的官方稳定版本介绍与 GitHub 下载直链。
- `GET /api/health`：非敏感服务状态。
- `GET /api/client/update-proxy`：每次操作都刷新私库配置与订阅，返回版本为 1 的固定节点配置，最多 16 条、32 KiB、`Cache-Control: no-store`，每 IP 每分钟 30 次。
- `GET /api/update?url=...`：仅保留官方 latest 元数据兼容；安装包和校验清单请求在读取代理配置前返回 410 升级提示，不传输文件。
- `POST /api/admin/login`、`POST /api/admin/logout`：同源管理员会话。
- `GET /api/admin/overview`：实际模块与配置状态，不包含订阅链接，也不声称代理健康。
- `GET /api/admin/config`、`PUT /api/admin/config`：管理员维护订阅，签名 Cookie、Origin、CSRF 和 GitHub 文件 SHA 防并发覆盖。
- `GET /account`：与客户端共用的用户注册、登录及偏好界面。
- `GET /api/account/session`：当前用户、CSRF 和 Google 登录配置状态。
- `POST /api/account/code`、`POST /api/account/register`、`POST /api/account/login`：发送注册验证码、注册并登录、账号或邮箱加密码登录。
- `PUT /api/account/profile`：更新昵称和账号名；`POST /api/account/password`：首次设置或修改密码。
- `GET /api/account/google/start`、`GET /api/account/google/callback`：系统浏览器 Google 授权入口与回调。
- `POST /api/account/device/start`、`GET /api/account/device/poll`、`POST /api/account/device/approve`：客户端一次性请求、带验证证明的轮询及已登录网页明确授权。
- `POST /api/account/logout`：撤销当前会话，网页同时清除 Cookie。
- `GET /api/account/data`、`PUT /api/account/data`：读取或更新当前用户的可跨设备复制偏好。
- `GET /api/account/apps/miniapp/data`、`PUT /api/account/apps/miniapp/data`：读取或同步小程序独立业务数据，PUT 必须携带读取到的 `revision`；过期返回 `409 REVISION_CONFLICT` 并保留原云端数据。

跨程序接入规范、GitHub App 配置和可复制 Skill 见 [共享用户数据说明](shared-user-data/README.md)。新 Brclio 客户端也发送 `revision`；兼容已安装客户端的无 revision 请求仍按字段合并，同字段的最后一次成功写入可能覆盖先前值。服务保留未知字段和其他应用目录，JSON 损坏或不支持版本时停止相关写入。`DATA_MIGRATION_READ_ONLY=true` 冻结账号写请求、Google 回调、设备授权领取和管理员配置写入，供迁移窗口使用；切换后要明确恢复新库写入，不能保留双库写入方。

订阅初始值来自环境，后台保存后以程序资料库 `BrclioData/BrclioData` 的 `config/update-proxy.json` 为准；该配置不属于个人账号。昵称、个人偏好和每位用户的小程序数据始终属于 `BrclioUserData`。客户端每次检查/下载各取一次最新配置，无需重新打包客户端即可维护订阅。节点的 UUID、连接地址等是客户端使用代理所必需，能从客户端/接口提取；订阅原链接、管理密码、GitHub App 凭据与会话密钥不下发。

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

账号验收另外覆盖邮箱实际收件与验证码过期、账号和邮箱两种密码登录、错误密码限流、Google 网页回调与客户端确认、退出后会话撤销、私库用户独立目录、跨用户数据隔离、偏好手动同步，以及离线/未登录时原有路径工具可用。只记录实际验证的阶段；不要从本地测试推断线上邮件或 Google 配置已可用。
