# Brclio 程序配置与公共资料仓库

本私有仓库 `BrclioData/BrclioData`（ProgramRepo）保存全局程序配置、程序公共资料与共享资源，持续供 Brclio、小程序和未来程序使用。账号、昵称、密码、个人设置，以及明确属于用户或关联 userId 的应用数据，统一保存在 `BrclioData/BrclioUserData`（UserData）。两个仓库按职责长期运行。

本规范作为 ProgramRepo 根目录 README，机器可读约定见 [protocol.json](protocol.json)。**当前状态：全局分库代码已部署，两库当前 main 的误放副本已清理，全局配置读写保护和分库后共享账号端到端均重新验收通过。**

当前 Worker 为 `16cc4a6e83854cf185940a03bdd9182f`，生效版本 `8bc269ab-a742-4459-95f5-9bc5db22212e`，22 项 binding 与 7 个继承的 Secret 已核验，原会话签名密钥保持不变；下载模块 SHA-256 为 `45a68fafc3188dd8eef14dba26fc79717c8241f87e26f09cc5800fe42ecbfbab`，主域及 Worker 备用域健康检查均为 200。线上管理配置 GET 为 200 且 blob SHA 与 ProgramRepo 一致，过期 SHA PUT 为 409、零文件变更，客户端配置 GET 为 200，匿名账号数据访问为 401。此记录不等于真实邮件注册或微信原生上传发布证明。

分库后隔离账号验收覆盖中央服务与 pocket 的三次登录、跨用户/跨应用隔离、读写、并发 200/409、无效越权和退出后 401；verification 为 262 项检查，含清理的 result 为 692 项检查。2 个 fixture、7 个测试文件和 4 条测试索引均已清理，stderr 为零；没有把配置就绪推断为真实邮件或 Google 新注册成功。

## 归属判断

| 数据 | 所属仓库 |
| --- | --- |
| 程序全局更新/代理配置、与用户无关的公共资料、共享资源 | ProgramRepo |
| 账号身份、昵称、密码、会话和身份索引 | UserData |
| 个人偏好、用户比赛历史、任意关联 userId 的业务数据 | UserData：`users/<userId>/apps/<appId>/...` |
| 统一账号数据 schema 注册 `apps/<appId>.json`、接入 README/协议/Skill、账号迁移审计 | UserData，作为必要账号管理支持材料 |

这里“公共”指程序层共享或由后端按权限提供的资料，不改变仓库私有属性，不表示所有配置或订阅地址都可直接向客户端公开。ProgramRepo 的未来 `apps/<appId>/...` 与 UserData 根的 `apps/<appId>.json` 用途不同，不能混放。

## 目录与兼容

```text
README.md
protocol.json
config/
  update-proxy.json          # 现有全局配置路径保持兼容
apps/
  <appId>/                  # 未来推荐的全局配置/公共资料/资源目录
```

`config/update-proxy.json` 继续沿用现有 version 1 格式与 `subscriptionUrl`、`updatedAt`、`updatedBy` 等字段，保留未知字段；本规范不写任何真实配置值。普通读写不能为了归类重命名该路径或覆盖整份配置。未来新增程序优先使用自己的 `apps/<appId>/...`，明确版本和升级方式；属于用户的条目一律回 UserData 的用户目录。

ProgramRepo 旧 `users/` 的 10 个 blob 已从当前 main 移除，清理 commit 为 `fad81f97b4abd7271f96ed463fa94a6eb2f03aa7`；原全局配置 SHA 不变，另发布 README/协议。UserData 仅删除误搬的 `config/update-proxy.json`，对应清理 commit 为 `ad6840ca7dc2eeb35b862d5639350c12db171ba7`，其全部账号和其他文件 SHA 保持原样。完整私有 Git bundle 已 verify，两库 head/tree 已以 0600 保存备份；历史迁移 manifest 与 Git 历史保留。上述是固定分离提交号，不把持续变化的文档发布 head 当作清理证据。

## 中央服务接入

源码位于 [Brclio/Brclio 的 cloudflare 目录](https://github.com/Brclio/Brclio/tree/main/cloudflare)。账号存储模块 `src/account-store.js` 使用 `GITHUB_DATA_REPOSITORY=BrclioData/BrclioUserData`；程序配置模块 `src/config.js` 使用 `GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData`。还须同步核验管理保存、配置缓存及 token 的仓库选择。缺少程序库配置或读写失败时显式报错，不能回退到 UserData 的误放副本。

两库共用中央服务的 GitHub App：配置 `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`，私钥只放 Secret `GITHUB_APP_PRIVATE_KEY`。现有 App ID `5409908`、安装 ID `173730859`；安装范围按用户选择保持 All repositories。每次操作仍只为实际仓库签发 Contents 读写/Metadata read 的单库短期 installation token，在服务端区分仓库缓存刷新。中央服务才持有这些凭据，客户端、小程序代理和各应用不取得 App 私钥、JWT、installation token 或个人 Token。

新程序经中央 API 取得允许使用的全局配置或接入统一账号，不自行在客户端连接 GitHub 私库。凡涉及注册、登录或用户数据，继续遵循 UserData 的接入 Skill 与账号协议。

## 更新、整理和恢复

现有全局单文件更新可继续使用 Contents API 并带读取到的 blob SHA；并发冲突先重新读取和比较，不盲目重放旧值。多文件更新以当前 head 的 `base_tree` 创建增量 tree 和单个 commit，再以 `force:false` 更新 ref。保留未知字段、其他应用和范围外文件；不重建根树，不把读取错误当空配置。

归属整理以每类数据的正确副本、备份和运行路由已核验为删除前提，不强制所有项目采用固定先后。本轮实际先部署分库并核验全局配置，再 prepare ProgramRepo 删除已列明的旧 `users/` 并发布规范，最后 clean UserData 的误放配置副本。不同内容先审计，不凭同名覆盖/删除；其他全局配置、公共资源、账号 schema 和支持材料留在各自仓库。

两个仓库没有跨库原子 Git commit，需记录各自提交与验证结果，失败时保留已核验备份并停止相关切换。清理完成后 ProgramRepo 仍正常读写全局配置；不双写同一类数据、不跨库回退。保留历史迁移 manifest 与 Git 历史，不用 force push 擦除旧副本；恢复从当前 head 做选择性补偿提交，保护事故后的其他合法更新。

部署配置、私库整理、全局配置实际读写、账号端到端、客户端安装和微信发布分别核验。已有账号测试通过不能证明新的全局分库已部署，也不能证明实际邮件注册或微信发布成功。
