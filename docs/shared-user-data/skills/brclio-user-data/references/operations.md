# 两库事务、账号导入与归属整理

先读 [repository-boundaries.md](repository-boundaries.md)。UserData 保存账号和用户归属数据，ProgramRepo 持续保存全局配置与公共资料；两库按职责运行，不是将整个旧库停用。普通客户端和业务代理均不持有 GitHub 凭据。

## 服务端凭据与仓库路由

App 创建/安装和用户生成 PEM 见 [github-app-setup.md](github-app-setup.md)。同一中央服务保留 `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、Secret `GITHUB_APP_PRIVATE_KEY`。`src/account-store.js` 使用 `GITHUB_DATA_REPOSITORY=BrclioData/BrclioUserData`；`src/config.js` 的全局配置使用 `GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData`。

用户选择的安装范围为 All repositories，已核验；不要自动收窄或移除仍在运行的程序库授权。每次按实际仓库兑换单库 Contents 读写 installation token，服务端缓存区分仓库、App、installation 与私钥身份并在过期前刷新。不能以 UserData token 访问 ProgramRepo，不得因任一仓库配置缺失静默回退另库。

账号导入工具分别读取目标 `GITHUB_INSTALLATION_TOKEN` 与源 `SOURCE_GITHUB_INSTALLATION_TOKEN`；App 包装器在内存签发并通过子进程环境传递单库 token。私钥/令牌不写命令行参数、日志、Git URL/config、客户端或仓库。新程序复用中央 API，不创建各自 GitHub 凭据。缺少真实凭据/权限时继续代码和离线工作，停止依赖该条件的操作并指出具体缺失。

## 每库写入事务

1. 确认实际仓库与该次数据类型相符、私库权限有效，读取默认分支与固定 head；未知版本、无权限、截断 tree、重定向和解析失败均停止。只有真正不存在的路径才使用约定空值，不能因错误初始化空索引。
2. UserData 的索引、资料、凭据与相关应用记录在同一个 head 上读取并以同一个 commit 更新。保留未知字段和范围外路径；使用有效、有限、无损 JSON，遵守账户存储和具体 API 的体积限制。
3. 以当前 commit 的 `base_tree` 创建增量 tree，原 head 为 commit parent，`force:false` 更新 ref。普通数据保存不删除未知内容或重建根树。已授权本次整理可删除经过准确列举和备份核验的误放副本，不能将该例外推广成日常清库权限。
4. 并发导致 409/422 时，从最新 head 重新读取并重算会话、revision 和变更，最多四次；不只重挂旧计算结果，回调不发送邮件等不可重复副作用。其他错误保留本地状态并停止相应写入。
5. 全局配置的现有单文件 `config/update-proxy.json` 可沿用其 SHA 条件 Contents API 更新；多文件变更同样用增量 tree/commit。保持现有格式和未知字段，冲突时重新读取，不无条件覆盖。
6. 提交成功后读回相应 head 与 blob SHA。日志仅输出动作、状态、计数和 SHA，不输出用户/配置值或凭据。Git ref 并发保护与用户应用 revision 冲突检测都需要，不能互相替代。

Git 事务只覆盖一个仓库。两库归属整理不具备跨库原子 ref 更新，必须记录各自 head/commit、受影响写入方和恢复步骤，不能声称“一次 Git commit 原子切换两库”。

## 新应用接入

UserData 根的 `apps/<appId>.json` 登记账号数据 schema、用户路径、API 与兼容规则，是账号管理元数据，保留在 UserData。中央服务显式注册 appId、业务校验与隔离测试后才开放接口；`brclio` 使用 `/data`，`miniapp` 使用 `/apps/miniapp/data`。

与用户无关的公共程序配置/资源另存 ProgramRepo 的 `apps/<appId>/...`；有关 userId 的业务记录仍回 UserData `users/<id>/apps/<appId>/...`。多个账户源即使邮箱相同也不能由客户端直接合并；需验证身份迁移依据并限定旧账号路径，不能为迁移账号停用整个 ProgramRepo。

## 账号导入工具

Skill 内的 `scripts/migrate-with-github-app.mjs` 与 `migrate-user-data.py` 可独立运行，无需 npm 安装，依赖 Node.js 20+、Python 3 和 Git。执行 apply 前确认实际打包版本仅筛选 `users/`。若旧包仍夹带 `config/update-proxy.json`，只可只读预检，先修正工具后继续；不能再次把全局资料迁进 UserData。

```bash
node <此技能目录>/scripts/migrate-with-github-app.mjs \
  --app-id <实际AppID> --installation-id <实际安装ID> \
  --private-key-file /absolute/path/to/private-key.pem
```

先审查只读计划，再在已授权的账号导入范围内追加 `--apply --writers-frozen --source-head <预检源SHA> --target-head <预检目标SHA> --backup-dir /absolute/new-private-directory`。这里只冻结原账号路径的写入；ProgramRepo 的全局配置仍按其独立维护策略运行。工具建立并核验私有 mirror/bundle、保留目标其他文件，以非强制提交迁移。备份位置与 SHA 可报告，用户值和凭据不得输出。

此导入工具不执行本次两库副本删除，也不负责变更全局读写路由。不能用重新 apply 导入代替归属整理。超时或失败先读回两库 head 和计划，保留已有备份，不盲目重放。

## 本次归属整理顺序

1. 记录当前两库 head 和完整 tree；递归列表被截断时逐子树遍历。限定已授权路径与对应写入方：UserData 的全局误放 `config/update-proxy.json`，ProgramRepo 的 `users/` 旧账号副本。保留所有范围外文件和未知字段。
2. 建立并验证完整私有备份，记录备份可读性、head、blob SHA、mode 和文件计数。Git 历史本身不能替代已验证的备份，备份不放公开仓库或附件。
3. 按完整 bytes/SHA 比对各记录：UserData 账号应包含 ProgramRepo 用户副本全部内容；ProgramRepo 全局配置与 UserData 误放副本需一致，或经审计明确每个不同字段的正确版本。只因 JSON 重排导致 SHA 不同时，完整语义与未知字段也必须相等。不同内容、缺失记录、身份冲突、解析失败先停止相关删除，不能猜测哪份更新。
4. 验证每类运行路由：account store 指向 UserData，`src/config.js`、管理写入、缓存键及 token 指向 ProgramRepo。线上检查账号读写、全局配置 GET 的程序库 blob SHA、过期 SHA 写入冲突与零变更、客户端读取。备份/正确副本与该类数据运行路由均已核验，才允许删除该类误放副本；不把前次账号验收当作本次全局路由已通过。
5. 按满足前提的准确清单清理：ProgramRepo 仅删旧 `users/`、UserData 仅删误放 `config/update-proxy.json`。两项不要求固定相对顺序；本轮实际为先部署分库并核验全局，再 prepare-program，最后 clean-user。不移动账号 schema 清单/Skill，不删除 ProgramRepo 其他目录。各以最新 head 的增量补偿 commit 非强制更新，分别记录提交。
6. 再验 UserData 索引、profile/credentials、用户业务和未知字段；再验 ProgramRepo 当前全局配置与公共资料完整。账号登录/跨设备同步、全局设置读取/保存均真实读回，输出结构计数和 SHA，不打印值。
7. 保留 `migrations/20261021T114651Z-6da923716022.json` 等历史审计记录及所有 Git 历史，不为移除当前副本擦除历史。历史中的旧账号或配置副本仍可被具备相应 Git 历史读取权限的人读取。记录两库清理 commit、备份、部署与验证结果；ProgramRepo 正常继续运行。

## 恢复

从当前 head 对确认受损的所属仓库、具体用户或配置做选择性补偿提交，保留事故后的合法更新。不能回退整库分支、force push 或重新混放两类数据。身份恢复同时核验索引与反向引用；程序配置恢复核验原格式及未知字段。只隔离受影响写入方，不把 ProgramRepo 整体当成废弃账号源停用。应用代码回滚与数据回滚分别核对，避免旧代码重新向错误仓库写入。

## 只读验证器边界

`validate_repository.py` 检查 UserData 协议、索引、用户目录、密码格式、已登记应用数据封装和 miniapp 已知业务约束，只输出结构错误与计数，不修改或打印用户值。它不是 ProgramRepo 校验器；也不证明真实密码、邮箱注册、线上部署、全局配置路由或完整 blob SHA。未知文件和业务字段保留；已审计的旧非 UUID ID 可用 `--allow-legacy-ids`。整理误放全局副本另按上述准确路径与全量核对执行，不能靠验证器“通过”跳过。
