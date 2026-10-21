# 创建并安装 Brclio GitHub App

本 App 只供中央服务按职责访问账号库 UserData 和程序库 ProgramRepo。用户在 GitHub 页面自行创建 App、选择安装仓库并生成私钥；AI 根据实际 App ID、安装页面链接和 PEM 本地路径完成服务端配置，不猜 ID，不把配置准备当作生产验收。

## 从正确的账号入口创建

优先在 `BrclioData` 组织创建：[组织下新建 GitHub App](https://github.com/organizations/BrclioData/settings/apps/new)。进入后确认所有者是 `BrclioData`；个人 `AndersonHJB` 设置页创建的 App 属于个人账号，不能把个人账号的“仅此账号”误认为包含所属组织。GitHub 支持个人或具备管理权限的组织注册 App，具体入口见 [GitHub 官方注册说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)。

如果已决定继续在个人账号下创建，将下表最后一项改为 **Any account**，以便安装到 `BrclioData`；安装时仍严格限制仓库。Any account 控制谁可安装 App，不会把目标私库改为公开。

## 创建表逐项填写

| GitHub 表单项 | 本项目取值 |
| --- | --- |
| GitHub App name | `Brclio User Data Sync`；若 GitHub 提示重名，增加可识别的名称后缀并记录最终名称 |
| Description | 可填 `Shared account and user data storage for Brclio applications.` |
| Homepage URL | `https://tools.brclio.com` |
| Callback URL / Redirect URI | 留空；这里不接入 GitHub 用户 OAuth 登录 |
| Expire user authorization tokens | 保持勾选；本方案不用 user access token，不影响 installation token 流程 |
| Request user authorization (OAuth) during installation | 不勾选 |
| Enable Device Flow | 不勾选 |
| Setup URL | 留空 |
| Redirect on update | 不勾选 |
| Webhook → Active | 不勾选；Webhook URL 和 Secret 留空 |
| Repository permissions → Contents | **Read and write** |
| Repository permissions → Metadata | **Read-only**，保留 GitHub 自动要求的权限 |
| 其余 Repository、Organization、Account/User permissions | **No access** |
| Where can this GitHub App be installed?（组织 `BrclioData` 所有） | **Only on this account** |
| Where can this GitHub App be installed?（个人账号所有，需装到组织） | **Any account** |

上述 OAuth、Device Flow 和回调配置属于 GitHub App 的用户授权功能，与 Brclio 自身的邮箱/密码、Google 登录、桌面设备授权不是同一流程，不能拿 Brclio 登录回调地址来填此表。权限按 [GitHub 官方最小权限说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) 设置。

## 安装范围与单库 token

创建后在 App 的 **Install App** 页面选择安装到 `BrclioData`。本次用户明确选择 **All repositories**，已由现场 API 核验 `repository_selection: all`；保留该配置，不自动移除仍在正常运行的程序库授权。两库长期职责是：

- ProgramRepo `BrclioData/BrclioData`：全局程序配置与公共资料。
- UserData `BrclioData/BrclioUserData`：账号、个人配置与用户归属的应用数据。

若用户以后主动采用最小安装范围，可选 **Only select repositories** 并选择实际需要的两库；这只是可选配置，不改变本次 All repositories 的选择。安装权限和实际 token 分开验证：账号操作兑换 UserData 单库 token，全局配置操作兑换 ProgramRepo 单库 token，不能用一库 token 访问另一库。最新全局分库调整需独立部署验收，不能因账号验证已通过就声称它也生效。安装可访问全部仓库，不意味着实际 token 也应扩大范围，参见 [GitHub 官方 installation token 说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)。

## 创建后提供什么

用户在实际 App 设置页找到 **App ID**，完成安装后保留该组织的安装配置页面 URL，再自行生成并保存 PEM 私钥文件。新版 GitHub 可在 **Credentials → Key pairs → New key** 中生成，部分界面显示为 **Private keys → Generate a private key**；以当前 App 设置页面为准。[GitHub 官方私钥说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps) 说明下载与保存方式。

向实施 AI 提供实际 **App ID**、**安装配置页面 URL**、**PEM 在本机的绝对路径**即可，无需把 PEM 内容或任何令牌粘贴到聊天。AI 仅为中央服务读取本地 PEM，将其写入服务端 Secret，核实安装归属和安装 ID；不得把 App ID 与 Client ID、仓库 ID 或安装 ID 混用，不得从示例猜值。

中央服务最终配置：

| 配置名 | 来源与用途 |
| --- | --- |
| `GITHUB_APP_ID` | 实际 App ID，中央服务签发 App JWT 使用 |
| `GITHUB_APP_INSTALLATION_ID` | 对 `BrclioData` 的实际安装 ID，根据安装配置 URL 和 GitHub API 核实 |
| Secret `GITHUB_APP_PRIVATE_KEY` | 用户生成 PEM 的完整内容，只保存到中央服务 Secret |
| `GITHUB_DATA_REPOSITORY` | `BrclioData/BrclioUserData` |
| `GITHUB_PROGRAM_DATA_REPOSITORY` | `BrclioData/BrclioData`，供 `src/config.js` 全局配置使用 |

服务端用同一个 App 的 RS256 JWT 按实际数据职责分别换取 UserData 或 ProgramRepo 的单库 Contents 读写 installation token，并区分仓库缓存刷新。App 凭据仅在中央服务；客户端与小程序代理不接收 App 私钥、JWT、installation token 或个人 Token。后续程序调用中央账号/程序配置 API，不创建自己的 GitHub 凭据。

创建 App、成功安装、服务端 Secret 配置、数据迁移、生产部署与实际读写验证需分别记录。App 配置尚未由用户提供或真实 token 尚未核验时，只能报告代码/文档准备完成，不能声称线上已完成切换。
