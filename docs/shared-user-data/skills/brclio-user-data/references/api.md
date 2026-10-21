# 统一身份与应用数据 API

中央 origin：`https://tools.brclio.com`。以下路径均以 `/api/account` 开头。上线前对实际部署验证，本文不能证明接口已经发布。

这些账号接口只读写 `GITHUB_DATA_REPOSITORY=BrclioData/BrclioUserData`。全局程序配置由中央服务的 `src/config.js` 使用 `GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData`，不通过用户数据接口保存；最新分库调整的部署状态独立核验。UserData 根 `apps/<appId>.json` 是账号数据 schema 清单，程序公共资料另放 ProgramRepo。

## 会话与代理

同源网页：`credentials:'same-origin'`，服务端设置 `__Host-brclio_user` HttpOnly/Secure/SameSite=Lax Cookie，写请求携带 session 返回的 `X-CSRF-Token` 和同源 `Origin`。网页会话当前有效期七天。

桌面或服务端代理：发送 `X-Brclio-Client: native`，请求不带 `Origin`；注册/登录返回 `token`，后续请求发送 `Authorization: Bearer <token>`。native 会话当前有效期三十天。Bearer 是当前用户会话，不是 GitHub App installation token 或其他 GitHub 凭据。会话服务端可撤销；不能仅检查本地 token 到期时间就认为仍有效。

原生小程序由 `wx.request` 访问 `https://pocket.bornforthis.cn/api/account/*`；不携带浏览器 Origin，代理转发时使用 native 方式。浏览器网页若另行接入，则使用自身同源代理并保持正常 Origin 行为。代理检查来源规则、固定允许的路径/方法与上游 `https://tools.brclio.com`，去掉 Cookie，不转发客户端指定的上游地址、Host 或任意敏感头。代理和客户端均不持有 GitHub App 私钥、App JWT、installation token 或个人 Token，不得以 GitHub 凭据代替用户登录。新程序只接中央 API，不创建各自 GitHub 凭据。登录令牌留在当前用户客户端会话中，不能写入业务云数据。微信合法域名、原生小程序/H5 各自接入和部署状态另行核实。

## 身份端点

| 方法与路径 | 请求 JSON / 说明 | 成功数据 |
| --- | --- | --- |
| `POST /code` | `{email}`，注册验证码，邮箱 trim 后小写 | `{ok,retryAfter,...}`；已注册邮箱可返回 `409 EMAIL_EXISTS` |
| `POST /register` | `{username,email,password,code}` | `{user,csrf,token?}`；native 返回 token |
| `POST /login` | `{identifier,password}`，identifier 为账号或邮箱 | `{user,csrf,token?}` |
| `GET /session` | Cookie 或 Bearer | `{user,csrf,passwordEnabled,googleEnabled,emailEnabled}`；未登录 user 为 null |
| `POST /logout` | `{}`，当前用户会话 | `{ok:true}`，撤销当前会话 |
| `PUT /profile` | `{username,nickname}` | `{user}`；用户名冲突返回 409 |
| `POST /password` | `{currentPassword?,newPassword}`；已有密码必须校验 currentPassword | `{ok:true,passwordEnabled:true}`；撤销其他会话 |

用户名 trim/NFKC 后 3–32 字符，仅中央服务现有规则允许的字母、数字和 `_.-`，首字符必须为字母或数字。密码长度 8–128；注册验证码六位。昵称 trim/NFKC 后至多 40 字符，禁止控制符和换行类字符。客户端校验服务于交互；以中央服务校验为准。

`user` 是 `{id,username,nickname,email,avatarUrl,providers}` 的公开资料投影；不含密码、密码派生记录或 sessions。普通客户端不能通过邮箱读取其他用户的资料。需要扩展资料或邮箱变更时，在中央身份服务增加原子索引更新，不在业务数据中另建身份。

Google 网页登录保留既有 `/google/start` 与 `/google/callback` 流程。桌面 Google 登录保留 `/device/start`、`/device/poll`、`/device/approve` 的设备授权协议与现有客户端实现，不能把网页 Cookie 直接当 native Bearer。新应用没有实现该流程时先使用已支持的密码登录，不声称 Google 原生授权已接通。

## Brclio 数据兼容接口

`GET /data` 返回 `{userId,preferences,updatedAt,revision}`。`PUT /data` 请求为 `{preferences,revision?}`，成功返回同形响应。新版客户端必须使用读到的 revision；旧版省略 revision 的行为仅作兼容，对相同偏好仍可能后写覆盖。

持久化路径：`users/<id>/apps/brclio/data.json`，封装为 `{version:1,revision:n,preferences:{},updatedAt}`。仅当新路径不存在，读取旧 `users/<id>/data.json`；首次后续写入会生成新路径，旧文件保留且只读。保留封装和 preferences 中未知字段。

允许的偏好：`pathMode` 为 absolute/relative；`quoteMode` 为 none/double/single/auto；`separator` 为 native/forward/backward；`joinWith` 为 newline/space/comma；`trailingSlash` 为 boolean。不能用此兼容 API 保存其他程序的业务数据。

## 应用数据接口

当前仅登记 `GET/PUT /apps/miniapp/data`。未来 appId 须同步修改应用清单和中央显式注册表及校验/测试；客户端请求任意其他 appId 返回 404。

不存在数据时 GET：

```json
{"userId":"<session-user-id>","appId":"miniapp","version":1,"revision":0,"data":{},"updatedAt":null}
```

PUT：

```json
{"revision":0,"data":{"duel":{"preferences":{"targetScore":3,"haptics":true,"names":["玩家一","玩家二"]},"matches":[]}}}
```

成功后 revision 加一，返回完整封装。服务端在一个 Git 事务内重新检查会话与 revision。客户端不得发送目标用户 ID；userId 始终来自会话。

`data` 是递归合并对象的 patch：两个值均为对象时递归合并；数组、数字、布尔、字符串、null 整体替换。省略不会删除。`null` 表示存储一个 JSON null，不表示删除对象键。所有未知 envelope/data 字段保留；应用升级不能只按已知字段重建整份记录。

`data` JSON 的 UTF-8 上限 12000 字节，完整请求上限 16384 字节，深度不超过 16，任一数组不超过 1000 项，任何深度禁止 `__proto__`、`constructor`、`prototype`。合并后的 data 同样必须满足上限。先预估字节并保留本机，不因 400 清空业务数据。

小程序业务键为 `duel.preferences:{targetScore:1|3|5,haptics:boolean,names:[string,string]}` 与 `duel.matches`。每局有 `{id,at,names,winner,scores,bestMs}`；`at` 是毫秒时间戳，winner 是 0/1，scores 是两个 0–5 整数，胜者得分为 1/3/5 且高于另一方，bestMs 为 0–5000 数字或 null。最多保留最近 20 局，稳定 id 用于识别重复比赛；沿用当前客户端对 id 字符和长度的校验。云端数组整体替换；需要合并本地/云端历史时先按 id 去重、按时间排序再截断，而非猜测服务端会合并数组。

中央服务读取已保存记录并在 PUT 递归合并后校验已知 `data.duel`，不满足时停止写入并保留原云端数据。`duel` 不存在时允许空数据及其他未知业务键；`duel` 一旦存在，必须含完整 `preferences` 和 `matches`。名字必须恰好两项，每项去除首尾空白后非空、原字符串最多 16 个 UTF-16 码元、无 U+0000–001F 或 U+007F 控制符。比赛 ID 为 1–80 位 `[A-Za-z0-9._:-]` 且同数组不重复，`at` 必须为至少 `1577836800000` 的 JavaScript 安全整数。未知对象字段保留，不根据已知 schema 重建或删除它们。

## 错误与重试

- `401`：保持本地数据，要求当前用户重新登录；不重放旧账号的待同步任务到新账号。
- `403`：修复 Origin、CSRF 或代理接入，不通过宽松 CORS 绕过。
- `409` + `REVISION_CONFLICT`：旧 revision 没有覆盖云端。先 GET 两边比较，保留本地，按业务规则或明确恢复选择处理；不得把旧 PUT 换上最新 revision 后盲目重试。
- `429`：遵守 Retry-After 与退避；不把限流当空用户或空数据。
- `5xx`、超时、JSON 不可解析：保留最后一次已知云端快照和本地未同步数据，先 GET 对账再判断是否重试。超时的 PUT 可能已成功，不能宣称必然失败。

“备份到云端”与“从云端恢复”先 GET 并展示预览。恢复必须得到用户对具体数据替换的明确选择；首次登录不自动清空本机或用默认值覆盖云端。交互已授权持续自动同步时，普通无冲突增量同步无需重复确认；冲突或恢复不能隐式选择丢弃一侧。
