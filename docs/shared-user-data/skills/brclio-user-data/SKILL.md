---
name: brclio-user-data
description: 将 Brclio、小程序或新应用接入 BrclioData/BrclioUserData 的统一账号与应用数据协议，实施命名空间隔离、并发同步、已有数据迁移和恢复。用于该私有仓库的接入或维护。
---

# Brclio 共享用户数据接入

将用户要求的程序接入 `BrclioData/BrclioUserData` 的账号身份、昵称、密码、个人配置与归属该用户的应用数据；沿用 `https://tools.brclio.com/api/account/*`。全局程序配置及公共资料归 `BrclioData/BrclioData`（ProgramRepo）。完成授权范围内的代码、配置和验证，并区分账号接入通过与全局分库调整的实际部署状态。

中央服务源码为 [Brclio/Brclio](https://github.com/Brclio/Brclio) 的 `cloudflare/`，应用路由和校验在 `src/account-data.js`，账号事务存储在 `src/account-store.js`，程序全局配置在 `src/config.js`。新增 appId 时一并修改中央路由和账号数据注册清单，使用现有中央服务，不另建身份服务。

按当前用户请求已授权的范围继续实施，不为正常可逆工作增加通用审批。只有实际缺少凭据、项目位置、部署条件或迁移授权时，说明具体缺失并停止依赖该条件的操作；继续其余可做工作。技能本身不授权超出用户请求的生产迁移、发布或删除。

## 接入规则

- 私库协议为 `version:1`。共享索引为 `users/_index.json`，包含 `usernames`、`emails`、`google`、`verifications`、`devices`。用户目录为不可变 UUID，含 `profile.json`、`credentials.json` 及 `apps/<appId>/data.json`。既有 ID 必须保留，改名不迁目录。
- 身份只由中央服务管理；所有程序沿用注册、登录、会话、资料与密码接口，不创建另一套密码库或签名密钥。用户路径来自已验证会话，不能来自请求体的 userId。
- 仓库所有者选择明文 JSON，并要求保留 `credentials.passwordPlaintext`。保留现有 `password:{algorithm:'PBKDF2-SHA256',iterations:100000,salt,hash}`：24 字节随机盐、32 字节派生值、base64url 无填充。不要改变该选择、还原旧哈希或伪造未知明文。客户端 API 不返回这些凭据。
- 两库分工：`GITHUB_DATA_REPOSITORY=BrclioData/BrclioUserData` 仅供 account store，`GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData` 供全局配置。UserData 的根 `apps/<appId>.json` 是账号数据 schema 注册元数据，README、协议、Skill、迁移审计也是必要账号管理支持材料；它们保留在 UserData。ProgramRepo 的 `apps/<appId>/...` 才是程序全局配置/公共资料。凡关联 userId 或属于用户的业务数据均进 `users/<id>/apps/<appId>/`。
- 同一中央服务的 GitHub App 持有 `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、Secret `GITHUB_APP_PRIVATE_KEY`；每次按实际账号库或程序库分别签发单库 installation token。任何客户端都不给个人 Token、App 私钥、JWT 或 installation token；新程序复用中央 API，不创建各自 GitHub 凭据。私库、Git 历史与备份均保持原访问边界。
- 本次 App 安装范围按用户选择保留 **All repositories**，已现场核验；不擅自缩成两库或移除程序库授权。安装范围不改变每次调用的单库 token 限制；不能用 UserData token 访问 ProgramRepo。
- 每程序只写自己的命名空间，保留未知路径和字段。读取失败、JSON 损坏、版本不支持不能当成空数据；不存在与读取失败必须区分。
- ProgramRepo 继续承担读写全局程序配置与公共资料的职责；只清理其中已完整迁入 UserData 的用户旧副本，不停用整个程序库。两类数据各有唯一归属，不同类双库并行运行属于正常分工；禁止同一账号或同一配置跨库双写/运行时回退。旧 `users/<id>/data.json` 兼容只发生在 UserData 内部。

先读 [references/repository-boundaries.md](references/repository-boundaries.md) 判断归属，再按需读 [references/api.md](references/api.md)。创建/安装 GitHub App 或接入 PEM 时读 [references/github-app-setup.md](references/github-app-setup.md)；持久化、迁移或恢复时读 [references/operations.md](references/operations.md)。这些参考随技能携带，不依赖原项目路径。

## 实施顺序

1. 检查当前项目及现有登录、存储、部署入口；读取 UserData 协议与应用账号数据清单，涉及全局配置时一并读取 ProgramRepo 协议。核验两个仓库变量分别被 account store 和 `src/config.js` 使用；不得因账号端到端已通过就假定新的全局分库调整已部署。仅检查 Secret 名称与权限，不输出值；既有仓库不能被初始化清空。
2. 复用已有 appId；新程序选择唯一的 `^[a-z][a-z0-9-]{0,47}$` ID，避免 `users/apps/profile/credentials/data/protocol/identity/system`。在 UserData 登记根 `apps/<appId>.json` 并修改中央账号路由、业务校验和隔离测试；全局资料另放 ProgramRepo 的应用目录。单独提交清单不会开放 API；当前通用路由仅启用 `miniapp`。
3. 接通统一身份。Brclio 同源网页沿用 Cookie+CSRF；native 采用 Bearer 与 `X-Brclio-Client: native` 且不带 `Origin`。浏览器跨站业务使用自身后端的固定上游代理，不尝试在浏览器删除 `Origin`。原生小程序由 `wx.request` 访问 `https://pocket.bornforthis.cn/api/account/*`，代理上游固定为中央服务，不转发 Cookie、不持有任何 GitHub 凭据。
4. 实现应用数据的 GET、带 revision 的 PUT、未知字段保留、本地离线保存、超时对账和冲突呈现。只有收到成功响应或读回核对成功，界面才显示“已同步”。切换用户时隔离本机待同步数据，不能把前一账号的数据静默上传给下一账号。
5. 保留旧数据。Brclio 新路径为 `users/<id>/apps/brclio/data.json`；旧 `users/<id>/data.json` 仅在新路径缺失时回退读取，不能删除或继续写旧路径。其他应用的本地数据不得在首次登录、网络失败或空云端响应时清空。
6. 验证注册/登录/退出、重启恢复会话、两个账号隔离、两个应用互不改写、两个设备 revision 冲突、超时后对账、未知字段保留、损坏记录拒绝覆盖。按项目实际部署入口测试代理；Cloudflare 产物含 `_worker.js` 时需验证该 worker 已调用代理，不能仅依赖未被使用的 `functions/`。
7. 已授权的迁移/分库清理按 operations 限定路径、冻结对应写入方、私有备份、完整 SHA 和语义核验后执行。UserData 的误放 `config/update-proxy.json` 与 ProgramRepo 的 `users/` 旧副本只可在正确归属库内容和路由已核实后清理当前 main；保留历史 manifest 与 Git 历史，不重写历史。已授权发布则完成部署及读回验证，分别报告阶段与限制。

## 同步不能省略的行为

通用数据为 `{version:1,revision:n,data:{},updatedAt}`；GET 返回 `userId`、`appId` 与该封装，PUT 为 `{revision,data}`。服务端递归合并对象，数组/标量整体替换，省略字段不删除。`data` 上限 12000 UTF-8 字节，请求上限 16384 字节，深度 16、单数组 1000，任意深度禁止 `__proto__`、`constructor`、`prototype`。

中央服务还校验小程序合并后的已知 `data.duel` 业务数据：有效偏好、双方非空无控制符名字、合法得分与获胜方、唯一比赛 ID 和最多 20 局；未知字段保留。新增 app 同样需要服务端业务校验，不能只依赖客户端。

HTTP `409`/`REVISION_CONFLICT` 时保留本地、重新 GET 并比较，按业务语义合并或让用户选择；不能把旧请求替换为最新 revision 后自动重放。超时也先 GET，避免已成功请求被重复应用。数组同步要用稳定 ID 合并或明确恢复选择，不能误以为服务端会逐项合并。

Brclio 的旧 `/api/account/data` 请求为 `{preferences,revision?}`，新客户端必须携带 revision；旧无 revision 客户端同字段最后成功写入仍可能覆盖，报告该兼容限制。

需要检查私库快照时运行：

```bash
python3 <此技能目录>/scripts/validate_repository.py /absolute/path/to/private-clone
```

脚本只做离线只读结构检查，不输出用户值，也不代表线上或迁移验收通过。旧系统经审计确有非 UUID ID 时可用 `--allow-legacy-ids`；新增用户仍生成 UUID。
