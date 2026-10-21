# Brclio 共享用户数据仓库接入规范

本私有仓库 `BrclioData/BrclioUserData` 只保存 Brclio、小程序及后续程序共用的账号身份、昵称、密码、个人配置，以及明确归属某个用户的各应用数据。一个账号对应一个不可变用户 ID 和独立目录；注册、登录、改名、改密由统一账号服务处理，各程序的用户数据放在该用户目录内的应用命名空间。

机器可读协议见 [protocol.json](protocol.json)，应用登记见 [apps/brclio.json](apps/brclio.json) 与 [apps/miniapp.json](apps/miniapp.json)。协议版本为 `1`。中央服务源码位于 [Brclio/Brclio 的 cloudflare 目录](https://github.com/Brclio/Brclio/tree/main/cloudflare)，新增应用路由及业务校验在 `src/account-data.js`，账号私库原子事务在 `src/account-store.js`，程序全局配置在 `src/config.js`。这些文件描述接入约定；代码完成、仓库整理、线上部署、客户端安装和重新启动验证是不同阶段，需要分别提供证据。

## 两个仓库的职责

| 内容 | 唯一所属仓库与位置 |
| --- | --- |
| 账号、昵称、密码、会话及身份索引 | 本仓库的 `users/_index.json` 与 `users/<userId>/` |
| 个人设置、用户拥有的应用数据 | 本仓库的 `users/<userId>/apps/<appId>/data.json` |
| 全局程序配置、程序公共资料和资源 | 程序库 `BrclioData/BrclioData`，现有 `config/update-proxy.json` 继续兼容，未来按 `apps/<appId>/...` 组织 |
| 应用账号数据 schema 注册清单、接入文档、Skill、审计记录 | 本仓库的 `apps/<appId>.json`、`README.md`、`protocol.json`、`skills/`、`migrations/`，作为账号管理的支持材料 |

程序库持续承担全局配置和公共资料读写职责。两库按数据归属各自维护一份真源；凡属于具体用户或关联用户 ID 的业务记录，均回到 UserData。这里根目录 `apps/<appId>.json` 是账号数据接入元数据，不是全局程序业务资料。详细判断与整理步骤见 [仓库归属参考](skills/brclio-user-data/references/repository-boundaries.md)。

## 直接交给其他程序的 AI

将 [skills/brclio-user-data](skills/brclio-user-data) 整个目录复制到目标 AI 的技能目录，例如 Codex 的 `~/.codex/skills/brclio-user-data/`，再发送：

```text
使用 $brclio-user-data，将当前程序接入 BrclioData/BrclioUserData。
沿用 https://tools.brclio.com 的统一注册、登录和会话；为当前程序登记独立 appId。
保留已有用户和本地数据，处理 revision 冲突，并完成实际可执行的接入和验证。
执行当前任务已授权的代码、配置和发布操作；对缺少的凭据、迁移权限或部署条件明确说明。
```

AI 不支持安装技能时，将目录中的 `SKILL.md`、`references/` 和 `scripts/` 一起交给 AI，并要求先阅读 `SKILL.md`。不要只复制技能入口而遗漏配套文件。该技能帮助 AI 按协议实施、核验与恢复，不能承诺任何情况下都绝不会丢失数据。

## 数据选择与凭据边界

按仓库所有者的明确要求，业务数据与 `passwordPlaintext` 均以明文 JSON 存储。`credentials.json` 同时保留现有 PBKDF2 密码记录供登录校验使用；不会用明文比较代替现有校验。Google 登录但尚未设置密码的账号可以没有 `passwordPlaintext`，`password` 为 `null`。旧账号缺少明文密码时，不得尝试还原哈希或填造密码；成功登录或设置密码后由账号服务记录。

仓库当前内容和 Git 历史均可被具有相应仓库读取权限的人或服务读取；后续删除字段不会清除已有历史。私有仓库及其备份必须保持私有。仓库访问采用统一账号服务持有的 GitHub App，不使用个人 Token 配置。App 私钥、App JWT 与短期 installation token 均不得写入仓库、客户端、安装包、文档示例、日志或前端环境变量。客户端只取得当前用户的会话令牌，不取得任何 GitHub 凭据或其他用户记录。读取接口不返回 `passwordPlaintext`、密码派生值或会话索引。

中央服务按职责配置两个仓库：`GITHUB_DATA_REPOSITORY=BrclioData/BrclioUserData` 供 account store 使用，`GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData` 供 `src/config.js` 的全局配置使用；同一 GitHub App 的 ID、安装 ID 和 Secret `GITHUB_APP_PRIVATE_KEY` 仅保留在中央服务。服务器用 RS256 App JWT 换取每次操作对应仓库的单库 Contents 读写 installation token，并按过期时间在服务端缓存刷新。新增程序直接复用中央 API，不创建各自 GitHub 凭据；也不得复制中央服务 `SESSION_SECRET` 创建第二套身份会话。

已通过现场 API 核验 GitHub App `brclio-user-data-sync`（App ID `5409908`，所有者 `BrclioData`）及其组织安装（Installation ID `173730859`），权限为 Contents write、Metadata read。按用户明确选择，安装范围保留 **All repositories**，API 已确认 `repository_selection: all`。账号操作仅取 UserData 单库 token，全局配置操作仅取 ProgramRepo 单库 token；安装范围不随整理自动收窄，也不移除仍需运行的程序库授权。

## 本轮实施记录（2026-10-21）

**最新职责整理及分库后账号验收均已通过**：账号使用 UserData，全局配置使用 ProgramRepo；同名 Worker `16cc4a6e83854cf185940a03bdd9182f` 的当前生效版本为 `8bc269ab-a742-4459-95f5-9bc5db22212e`。22 项 binding 为原 21 项加 `GITHUB_PROGRAM_DATA_REPOSITORY`，7 个 Secret 继承且原会话签名密钥精确保留；下载模块 SHA-256 为 `45a68fafc3188dd8eef14dba26fc79717c8241f87e26f09cc5800fe42ecbfbab`，两域健康检查均为 200。分库后的真实隔离测试账号已重新通过中央服务和 pocket 代理的三次登录、跨用户/跨应用隔离、读写、并发 200/409、无效越权和退出后 401；verification 为 262 项检查，含最终清理的 result 为 692 项检查，2 个 fixture、7 个文件与 4 条索引均清理成功，stderr 为零。

本轮实际先部署分库代码并核验程序配置路由，再 prepare ProgramRepo、最后 clean UserData。ProgramRepo 清理 commit 为 `fad81f97b4abd7271f96ed463fa94a6eb2f03aa7`：从当前 main 移除 10 个旧用户 blob，原全局配置 SHA 不变，另发布程序库 README/协议。UserData 清理 commit 为 `ad6840ca7dc2eeb35b862d5639350c12db171ba7`：仅移除误搬的 `config/update-proxy.json`，全部账号及其他文件 SHA 保持原样。完整私有 Git bundle 已 verify，两库 head/tree 已按 0600 保存备份；原 Git 历史和迁移 manifest 保留。线上全局管理配置 GET 返回 200 且与程序库 blob SHA 一致，过期 SHA 的 PUT 返回 409 且零变更；客户端配置 GET 为 200，匿名账号数据访问为 401。

最终测试清理后的 UserData tree 与固定清理提交 `ad6840ca7dc2eeb35b862d5639350c12db171ba7` 相同：3 位既有用户的原 10 个账号 blob 及 3 个派生 Brclio blob 均保持原始 SHA；ProgramRepo 的原全局配置 blob SHA 也完全一致。这里用固定整理提交和内容核验作证，不把后续文档发布 head 写回文档。

- **首次账号迁移历史已核验**：当时复制 3 位既有用户相关记录、11 个源 blob 及 3 个派生 Brclio 应用数据文件，全部 blob SHA 已核对；11 个源 blob 包括此后已纠正归属的全局配置副本。迁移 commit 为 `14e35c9790cb071c80d6c9d6d996e5300c0fd492`，审计记录 `migrations/20261021T114651Z-6da923716022.json` 和完整私有 Git bundle 备份继续保留，作为历史证据，不作为今后继续复制全局配置的规则。
- **中央服务重建恢复历史**：原 Worker 的内部 service binding 调用实测返回 `This script has been killed.`，常规重新发布未恢复；经用户批准删除旧实例后同名重建，恢复阶段版本为 `fba07c0c-3066-41f8-8111-10d9a48adb74`。当时 21 项 binding 已逐项恢复并核对一致，原会话签名密钥保持不变，旧个人 Token 配置 `GITHUB_TOKEN` 已移除。公开 API 未说明原实例被停用的触发原因，不能据此归因为某段业务代码；当前版本以上述分库部署记录为准。
- **线上账号与同步验收已通过**：在 `2026-10-21 21:38:33`（Asia/Shanghai，UTC+8），主域与 Worker 备用域健康检查均返回 200。`verify-account-live --ready` 全部通过，Google 和邮件配置就绪标志均为 true；本轮未实际发送注册邮件，不能据此声称邮件注册流程已验收。隔离测试账号验证了中央服务与 pocket 代理的三次登录、读写、并发写入一成功 200/一冲突 409、未知字段保留、跨用户及跨应用隔离、退出后会话撤销。finally 已清理全部 2 个测试用户、7 个测试文件和 4 条测试索引，`cleanupSucceeded: 1`。
- **整理前的只读数据基线已核验**：3 位既有用户、6 份应用记录、16 份 JSON，结构错误为零；目标历史包含上述迁移 commit。当时 11 个迁移 blob 的原始 SHA 全部一致，索引及未知字段保持原样；程序库整理前的历史 head 为 `d3ca6ac7447129312cc3063c557d4b7696964e46`。后续按职责删除当前 main 的副本时须生成新的审计结果，不修改这份历史验收记录。
- **小程序代理和网页窄修已生产验证，微信发布尚无证明**：当前 Pages 生产部署为 [21884f14](https://21884f14.brclio-miniapp-wechat.pages.dev)，旧 `8a60550b` 仅是早期账号联调的历史版本。`pocket.bornforthis.cn` 和 `pocket.brclio.com` 各自的 `/`、`/projects/ready-go-duel/`、`/projects/ready-go-duel/match/bundle.js` SHA-256 均与本地产物一致；各域 native 方式的匿名 session 为 200、私有应用数据为 401，每域 5 项、共 10 项实测通过。16 字符玩家名/未知字段保留/读取错误拒绝覆空的网页修复已随该部署生效，最新本地 174 项测试与构建通过。微信开发者工具本轮 UI 操作返回 `noWindowsAvailable`，尚无新原生页 fresh 编译、上传或审核发布证明；也不声称真实邮件或 Google 新注册已验证。

最新接入规范以 UserData 作为账号与用户归属数据的唯一源，以 ProgramRepo 作为全局程序配置与公共资料的唯一源。程序库继续提供正常的全局配置读写，账号服务不将其作为第二套账号来源；全局配置也不从 UserData 跨库回退。下文旧 `users/<id>/data.json` 的只读兼容仅指 UserData 内部保留的旧文件路径。实际全局路由分离的部署状态以上述最新整理记录为准。

实际创建表的填写、组织/个人账号安装选项及 PEM 服务端配置见 [GitHub App 创建与安装指引](skills/brclio-user-data/references/github-app-setup.md)。

## 仓库目录

```text
protocol.json
README.md
apps/
  brclio.json
  miniapp.json
skills/brclio-user-data/
  SKILL.md
  references/
  scripts/validate_repository.py
users/
  _index.json
  <immutable-user-uuid>/
    profile.json
    credentials.json
    data.json                    # 若旧账号已有，保留且只读
    apps/
      brclio/data.json
      miniapp/data.json
      <future-app-id>/data.json
```

新用户 ID 由中央服务生成 UUID，不使用用户名、邮箱或第三方 openid 作为文件夹名。改名、修改邮箱与绑定登录方式均不得改变用户 ID。迁移既有 ID 时先审计并保持其身份，不得为了目录样式重新注册用户。用户数据存储在自己的目录内；`users/_index.json` 是跨用户身份查询及临时流程的必要共享索引。

每个应用的用户数据只写 `users/<当前会话用户 ID>/apps/<已登记 appId>/`。全局配置和公共程序资源放 ProgramRepo，不能借应用接入把它们写入 UserData。UserData 的根 `apps/<appId>.json` 仅登记账号数据 schema 和接口契约；清单不等于开放 API，新增应用还须在中央服务显式登记路由、增加业务校验和隔离测试。当前通用应用 API 只启用 `miniapp`，不接受客户端任意指定用户 ID 或任意路径。

不得删除、重建或覆盖未知目录、应用、JSON 字段；不得把读取异常、无权限、JSON 损坏或不支持的版本当成“空数据”。只有实际不存在的路径才可使用约定的空值。未来协议版本不兼容时停止写入并报告，不能静默降级到版本 `1`。

## 共用身份格式

`users/_index.json`：

```json
{
  "version": 1,
  "usernames": {},
  "emails": {},
  "google": {},
  "verifications": {},
  "devices": {}
}
```

`usernames`、`emails`、`google` 分别将规范化用户名、规范化邮箱、Google `sub` 映射到同一个用户 ID。用户名沿用中央服务的 trim、NFKC 和小写索引规则；邮箱沿用 trim 和小写规则。`verifications` 保留验证码验证记录，`devices` 保留短期设备登录请求，二者不是用户表。设备记录的 `userId` 一经存在，必须指向有效用户。不得在应用端自行按邮箱合并账号或创建第二套索引。

`profile.json` 沿用 `version:1`、`id`、`username`、`email`、`emailVerified`、`providers`、`createdAt`，以及已有的 `nickname`、`avatarUrl`、`updatedAt` 等字段。`id` 必须与目录 ID 相同。

`credentials.json` 沿用 `version:1`、`password`、`passwordPlaintext`、`googleSub`、`sessions`、`failedAttempts`、`lockedUntil` 等已有字段。`password` 有值时格式为：

```json
{
  "algorithm": "PBKDF2-SHA256",
  "iterations": 100000,
  "salt": "<24-byte-random-salt-base64url-without-padding>",
  "hash": "<32-byte-derived-key-base64url-without-padding>"
}
```

`sessions` 的键为会话 ID 的 SHA-256 摘要，值为 `{ "exp": <Unix秒>, "mode": "web或native" }`。所有身份文件、索引、密码及会话只能由中央账号服务更新；业务客户端不得直接调用 GitHub 写这些文件。

## 登录与跨平台访问

中央服务固定为 `https://tools.brclio.com/api/account/*`。注册、邮箱验证码、登录、会话、退出、账号资料和修改密码接口见技能中的 [API 参考](skills/brclio-user-data/references/api.md)。跨程序沿用同一用户身份；各客户端仍独立登录取得自己的会话，不共用浏览器 Cookie 文件。

Brclio 网页使用同源 HttpOnly Cookie，写请求同时携带会话返回的 `X-CSRF-Token`。桌面客户端采用原有设备授权流程或密码登录，使用 `Authorization: Bearer <用户会话令牌>`；native 请求必须带 `X-Brclio-Client: native`，且不带 `Origin`。

原生小程序通过 `wx.request` 访问 `https://pocket.bornforthis.cn/api/account/*` 的服务端代理，再由代理访问中央服务。代理限制路径与方法，拒绝不符合本域规则的浏览器 `Origin`、去掉 Cookie，然后将用户 Bearer 与 `X-Brclio-Client: native` 转发给固定中央地址；原生请求本身不携带浏览器 Origin。若后续接入浏览器网页，应使用自身同源代理，不能伪造或试图删除 `Origin` 绕过限制。代理不保存 GitHub App 私钥、JWT、installation token 或个人 Token，不接受客户端指定上游 URL，也不另建注册和密码数据库。实际 `_worker.js` 构建需接入代理；仅添加未被当前构建使用的 `functions/` 文件不代表接口已生效。微信合法域名、发布审核、代理部署与中央 API 部署需分别验证。

## 应用数据与冲突

Brclio 继续使用 `GET/PUT /api/account/data`。数据保存在 `users/<id>/apps/brclio/data.json`，结构为 `{version:1,revision:0,preferences:{},updatedAt:null}`。若该路径缺失，才从旧 `users/<id>/data.json` 只读回退；后续写入始终写新路径。旧路径不删除、不再写入。新客户端发送读取到的 `revision`；为兼容已安装客户端，旧请求暂可省略它。这类旧请求会合并偏好并保留未知字段，但同一个偏好字段仍可能由最后一次成功写入覆盖，不能据此宣称完整的并发保护。

小程序和后续完成登记的应用使用：

```http
GET /api/account/apps/miniapp/data
```

```json
{"userId":"<session-user-id>","appId":"miniapp","version":1,"revision":0,"data":{},"updatedAt":null}
```

```http
PUT /api/account/apps/miniapp/data
Content-Type: application/json
```

```json
{"revision":0,"data":{"duel":{"preferences":{"targetScore":3,"haptics":true,"names":["玩家一","玩家二"]},"matches":[]}}}
```

服务端从会话确定用户，以当前 revision 为条件写入；成功后 revision 加一并返回完整数据。对象递归合并，数组和标量整体替换，缺失字段保留；清空数组需要显式发送 `[]`，不能通过省略字段删除。未知字段在读改写和升级过程中继续保留。

`data` 必须为 JSON 对象且序列化后 UTF-8 不超过 12000 字节；整个请求不超过 16384 字节，JSON 深度不超过 16，单数组不超过 1000 项。任何深度禁止 `__proto__`、`constructor`、`prototype` 键。小程序保留 `duel.preferences` 和最近 20 局 `duel.matches`；中央服务在合并后同样校验已知 `duel` 业务字段，包括双方名字去掉首尾空白后不得为空、原字符串不超过 16 个 UTF-16 码元且无控制字符。未知业务字段继续保留；账号和 Token 不放进业务数据。

revision 过期返回 HTTP `409` 和 `code: "REVISION_CONFLICT"`，不覆盖云端。客户端保留本地未同步数据，重新读取云端，展示两边的差异或恢复预览，再按应用规则合并或让用户选择。不得只改成最新 revision 后自动重放旧 PUT；网络超时也要先 GET 对账，因为原请求可能已提交。界面必须区分“本地已保存”“同步成功”“冲突待处理”“同步失败”。小程序备份与恢复均先读取云端并展示预览，恢复经用户明确选择后才替换本机数据。

## Git 写入、迁移和恢复

单次业务事务固定读取一个分支 head，以该 commit 的 `base_tree` 创建只包含变更文件的增量 tree，再创建一个关联原 head 的 commit，最后用 `force:false` 更新 ref。多文件身份变更必须在同一个 commit，不能逐个 Contents API 写索引和资料。并发导致 ref 更新失败时，从最新 head 重新读取并重新运行整个变更与 revision 校验，最多尝试四次；不能只把旧计算结果挂到新 head 上。重试中的变更函数不得发送邮件或执行其他不可重复的外部副作用。

迁移或分库整理先确认两库私有和权限、限定本次账号/全局配置变更路径、冻结受影响的相应写入方，保存完整私有备份及两库 head，再逐 blob 和语义核对。账号迁移只带用户归属数据，不夹带 ProgramRepo 的全局配置或公共资料；范围内未知用户文件和字段照常保留。不同内容、身份冲突、损坏记录或截断树均停止对应变更。首次迁移误放副本的删除仅限已授权并审计过的当前 main 路径：UserData 的 `config/update-proxy.json`、ProgramRepo 的 `users/`；先确认各自正确仓库有完整副本及现行读取路由，再以非强制补偿提交整理，历史 manifest 和 Git 历史保持可追溯。不能以清理账号副本为由停用 ProgramRepo 或删除其全局配置。详细操作见 [迁移与恢复参考](skills/brclio-user-data/references/operations.md)。

恢复以当前最新 head 为基底，对确认损坏的应用或用户字段创建选择性补偿 commit，保留其他应用在事故后的合法提交。禁止 force push、整库 reset、重建根树或通过回退整个分支丢弃后续用户写入。Git 历史提供恢复证据，但不是已经完成且可用的备份证明。

离线验证克隆或私有备份：

```bash
python3 skills/brclio-user-data/scripts/validate_repository.py /absolute/path/to/BrclioUserData
```

脚本只读，检查协议、索引指向、用户文件及已登记应用记录；只输出数量与结构性错误，不打印真实身份、密码或业务值。它不证明线上发布，也不替代迁移的完整 blob SHA 核对。旧系统确有非 UUID 用户 ID 时，先审计，再用 `--allow-legacy-ids` 保留原 ID 验证；不能借此为新用户创建非 UUID ID。
