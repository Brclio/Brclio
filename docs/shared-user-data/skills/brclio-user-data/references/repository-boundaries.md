# 账号库与程序库的归属

这两个私库同时服务中央后端，各自维护不同类型数据的一份真源。ProgramRepo 持续运行，不是已停用的账号旧库。

| 判断 | 仓库 / 路径 |
| --- | --- |
| 能指出属于哪个用户，或业务记录关联 userId | `BrclioData/BrclioUserData`：`users/<id>/apps/<appId>/...` |
| 账号身份、昵称、密码、会话、身份索引 | UserData：`users/_index.json`、`users/<id>/profile.json`、`credentials.json` |
| 个人偏好、用户自己产生的比赛历史、个人应用记录 | UserData：`users/<id>/apps/<appId>/data.json` |
| 与具体用户无关的程序全局参数、共享公共资料、全局资源 | `BrclioData/BrclioData`（ProgramRepo）：现有 `config/update-proxy.json`，未来推荐 `apps/<appId>/...` |
| 账号数据 schema 注册、接入说明/Skill/协议、账号迁移审计 | UserData：根 `apps/<appId>.json`、`README.md`、`protocol.json`、`skills/`、`migrations/` |

UserData 根的 `apps/brclio.json` 与 `apps/miniapp.json` 是统一账号服务的用户数据契约，不是程序的公共业务配置，不能随全局配置整理移到 ProgramRepo。ProgramRepo 中的“公共”表示程序层共享或由服务端按权限发布，私库可见性和秘密访问边界不因此改变。

## 服务端路由

- account store（`cloudflare/src/account-store.js`）：`GITHUB_DATA_REPOSITORY=BrclioData/BrclioUserData`。
- 全局配置（`cloudflare/src/config.js`）：`GITHUB_PROGRAM_DATA_REPOSITORY=BrclioData/BrclioData`；`config/update-proxy.json` 继续用原路径/格式。
- 同一 GitHub App 的凭据仅在中央服务。安装范围按用户选择保持 All repositories；访问任一仓库时都只换取该仓库的单库 token，缓存键包含仓库、App、installation 与私钥身份。
- 不以缺少程序库配置为由回退到 UserData；也不以账号库读取失败为由回退读取 ProgramRepo 的旧账号副本。正确仓库读取失败要显式报告，不能当空库覆盖。
- 新程序调用中央账号或程序配置 API，不把 GitHub 凭据、任意路径选择或任意目标仓库暴露给客户端。

## 本次整理与历史

最新全局分库已部署，全局管理/客户端读取与过期 SHA 冲突保护、两库 main 清理以及分库后隔离账号端到端均已重新核验。前次迁移将 `config/update-proxy.json` 带入 UserData 的历史仍保留，该配置已从 UserData 当前 main 移除。具体固定提交号、版本和检查数量见两库 README/协议；不能把历史文档发布 head 当作分离 commit。

整理按各类数据的前提执行，不强制所有项目采用同一先后：备份和完整副本已核验，账号路由已使用 UserData，才可清理 ProgramRepo 的旧 `users/`；全局配置路由已使用 ProgramRepo 且读写验证通过，才可清理 UserData 的误放配置。本轮实际先部署并核验分库，再 prepare ProgramRepo，最后 clean UserData。不同内容先保留并报告，不顺便删除未知文件或其他应用内容。

每个仓库独立提交，跨仓库不存在一次 Git ref 原子发布。全过程记录两边 head、备份、配置部署和清理 commit；中途失败保留备份并停止相应切换，不用 force push 统一回退两库。历史迁移 manifest 与 Git 历史保留，包括历史中存在的旧副本；当前 main 清理不等于擦除历史。

随技能的历史迁移工具不能自动判断所有全局/用户归属，也不负责本次副本删除。执行账号导入 apply 前必须确认其筛选只含 `users/`；发现仍夹带 `config/update-proxy.json` 的旧包时只做只读预检，先修正工具再执行。不能照前次“整库搬走后停用源库”的方式操作现在的 ProgramRepo。
