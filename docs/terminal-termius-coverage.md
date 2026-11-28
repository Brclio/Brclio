# Brclio 测试版与 Termius 桌面功能对照

核对日期为 2026-11-28。本机安装的 Termius 桌面版为 9.35.4。目标平台为 macOS（Apple 芯片、Intel）和 Windows x64。下表以用户能从界面完成的操作为准。「部分」列出缺少的行为，「待实测」表示代码路径已存在，尚缺对应的外部环境。每次打包结果可在测试分支的 [Desktop terminal 验证记录](https://github.com/Brclio/Brclio/actions/workflows/desktop-terminal.yml?query=branch%3Acodex%2Ftermius-desktop) 核实。功能范围来自 [Termius 官方功能表](https://www.termius.com/pricing) 和 [桌面文档](https://docs.termius.com/)。

测试 CI 分别提供 `terminal-preview-mac-arm64`、`terminal-preview-mac-x64` 和 `terminal-preview-win-x64`。解开下载包及其中的 ZIP 后，打开 macOS 的 `Brclio Terminal Preview.app` 或 Windows 的 `Open Brclio Terminal.cmd` 即可直接进入终端。预览版使用独立用户目录，禁用正式版更新、全局快捷键、登录启动和右键菜单注册。开发者可在目标系统准备项目依赖和内置媒体运行时后，运行 `node scripts/terminal-preview-build.cjs` 构建并验证本机预览包。

## 连接、传输与认证

| 功能 | Brclio 测试版与验收边界 |
| --- | --- |
| 本地终端 | 主窗口内打开 Shell，弹出及收回保留原 PTY；覆盖 macOS 登录 Shell 和 Windows ConPTY。 |
| 终端外观、键盘与文本 | 已有窗格配置支持字体、颜色、光标样式、快捷键和滚动记录。可查找当前或全部窗格、复制选区、预览粘贴内容。 |
| SSH、交互式 SFTP | 从主机库选择地址、端口、用户和身份，通过系统 OpenSSH 连接。图形文件浏览可独立打开。 |
| Telnet | 手动连接指定地址，可设置端口。 |
| Mosh | 使用本机安装的 mosh；Windows 需要默认 WSL 发行版，远端需要 mosh-server。未覆盖公网漫游及断网恢复的全流程。 |
| 串口 | 可列出设备、设置波特率、数据位、校验、停止位及流控；硬件通信仍需指定串口设备实测。 |
| 本地、远程和动态端口转发 | 有单独入口、模板及连接生命周期；回环测试验证真实端口流量。 |
| SSH 代理转发和跳板链 | 按主机显式启用代理转发，跳板按次序交给 OpenSSH。 |
| 上游 HTTP CONNECT、SOCKS5 | SSH 及图形/命令行 SFTP 可选代理。支持代理密码提示，沿用 OpenSSH 的目标指纹校验。 |
| SFTP 两个端点 | 可从“浏览本机目录”直接开始，两个窗格可独立选择本地或远端。可按名称筛选、多选或全选可见项目，逐项复制文件和整个目录，支持双远端传输、拖放和取消。两个窗格分别保留最近 64 个路径的前进、后退记录，提供目录收藏、点文件开关、重命名、新建目录、删除及远端权限和修改时间查看。 |
| 外部编辑远程文件 | 在 TextEdit、记事本或用户选择的编辑器中打开。文件类型关联保存在当前账号的本机分区，支持查看和恢复默认编辑器。确认回传前核对远端文件变更。 |
| SSH 和文件管理切换 | SSH 窗格可直接打开同主机图形 SFTP。两个文件窗格均可返回匹配的 SSH 会话或新开同主机 SSH，切回时保留目录和选择。文件菜单可复制完整本机或远端路径。 |
| 远端文件权限 | 可为选中的远端文件或目录编辑三位八进制权限，保留特殊位并复核服务器结果。需要远端支持 OpenSSH 的 `lsetstat@openssh.com`，NTFS 的完整访问控制列表不在此界面中。 |
| SSH 密钥、身份和证书 | 选择本地私钥、生成 Ed25519 / RSA / ECDSA、查看公钥指纹、绑定 OpenSSH 用户证书；可管理已知主机。签发证书需用户自己的 CA。 |
| FIDO2 | SSH 身份窗口可查询系统 OpenSSH 声明的 ECDSA-SK 和 Ed25519-SK 算法，并使用 ssh-keygen 发起生成。实体密钥注册和触摸签名待实测。 |
| PIN 与生物识别 | 桌面 PIN 锁覆盖闲置、系统锁屏、重启解锁和会话恢复。macOS 接入 Touch ID。Windows 使用带 Brclio 窗口句柄的 UserConsentVerifier，在系统可用且用户已注册 Windows Hello 时提供解锁。实体认证及 SSH 生物识别签名待验。[微软桌面验证接口](https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync) |
| SSH ID、设备绑定的 SSH passkey | 外接 FIDO2 与平台生物识别解锁各有独立路径。设备密钥托管、SSH ID 公钥分发及生命周期尚缺。 |
| 后量子密钥交换 | 主机高级设置可用系统 `ssh -Q kex` 查看已实现的混合算法；每台主机在本机可选“跟随系统默认”或“要求后量子协商”。严格模式为目标 SSH、命令行和图形 SFTP、端口转发强制使用共同支持的混合算法并重新握手。本机 OpenSSH 10.5p1 与独立回环 sshd 实际协商 `mlkem768x25519-sha256`，仅支持传统算法的服务端被拒绝。Windows 结果以实际运行的原生 OpenSSH 版本和隔离 sshd 用例为准。 [协商测试](../desktop/terminal-post-quantum.test.cjs) · [OpenSSH 后量子密钥交换](https://www.openssh.org/pq.html) |

验证入口包括 [协议、转发及证书](../desktop/terminal-forward.test.cjs)、[SFTP 协议](../desktop/terminal-sftp.test.cjs)、[文件浏览器](../scripts/verify-terminal-sftp.cjs)、[上游代理](../desktop/terminal-proxy.test.cjs)、[身份](../desktop/terminal-identity.test.cjs) 和 [终端锁](../scripts/verify-terminal-lock.cjs)。官方参考包括 [SFTP](https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp)、[密钥与证书](https://docs.termius.com/keychain/ssh-keys-and-certificates) 和 [SSH ID](https://docs.termius.com/ssh-id-passkeys-for-ssh/what-is-ssh-id)。

## 主机组织与工作区

| 功能 | Brclio 测试版与验收边界 |
| --- | --- |
| 主机、分组、标签 | 支持增删改、复制、收藏、分组过滤、搜索和最近连接。 |
| 分组配置与环境变量 | 子分组和主机可以覆盖上级的 SSH 用户名、端口、跳板和环境变量。分组可引用本机 SSH 身份，每台已保存主机单独授权后，SSH、SFTP 和手工启动的转发才能使用它。授权绑定主机、分组、有效用户名、端口、跳板、代理和身份路径。账号迁移或目标变更后要重新授权。组配置及授权保存在当前设备的账号中。远端须通过 AcceptEnv 接收环境变量。 |
| Shell 历史 | 设备内按账号主动开启，可按命令内容搜索或清理。只采集带集成标记的已回显单行命令。远端 Bash 的既有历史文件和跨设备历史尚未接入。 |
| 命令补全 | 搜索当前账号的命令历史、剪藏和常用命令，选择后填入当前窗格；开启后，在有 Shell 标记的提示符输入前缀可点选单行建议。输入路径或命令参数可点击“补全路径或参数”，让当前窗格中的 Shell 实时处理 Tab，包括支持该交互的远端 Shell。尚缺独立于远端 Shell 的文件候选列表、参数说明和密码提示关联身份。 |
| 工作区 | 多标签、分屏、命名、保存/恢复布局及工作区模板。选择器支持列表或网格查看运行状态和最近活动。保存布局时可选择记住主机引用，恢复时逐窗格确认，主机路由、用户名或身份有变更时重新核对。 |
| 剪藏 | 可分包、搜索、填写变量、预览、填入当前窗格。旧的剪藏和笔记可继续使用。 |
| 启动剪藏 | 每台已保存的主机可指定启动剪藏；建立会话后由用户确认，填入当前窗格。 |
| 多窗格输入与片段多目标执行 | 已打开窗格支持手动广播。未提供自动登录一组主机并运行片段的功能。 |
| OpenSSH config 导入 | 选择文件后预览具体主机，支持 User、Port、IdentityFile、CertificateFile、ProxyJump、部分 Host 通配规则和首值优先。Include、Match 条件段及 ProxyCommand 不执行。私钥文件及 known_hosts 不批量导入。 |
| CSV 和 PuTTY 导入 | CSV 支持名称、地址、端口、用户、组和标签。Windows 可在确认后读取当前用户 PuTTY Sessions 中的 SSH 主机。macOS 和 Windows 均可逐个选择 PuTTY 会话文件，也支持 UTF-8/UTF-16 注册表导出。新发现的会话由用户勾选后保存，字段限于名称、主机、用户名和端口。PPK 转换、隧道及密码迁移尚缺。[PuTTY 官方存储说明](https://www.chiark.greenend.org.uk/~sgtatham/putty/faq.html#faq-settings) |
| MobaXterm 与 SecureCRT 导入 | MobaXterm 明文书签支持 .mxtsessions、INI 的 Bookmarks 节和单个 .moba，读取 SSH 主机、端口、用户名、嵌套分组，支持 Windows-1252。SecureCRT 支持明文 VanDyke 设置 XML 的 Sessions 树和单个会话 INI，读取 SSH 主机、端口、用户名和 XML 分组。文件选择后逐项预览，加密导出、密码、隧道及其他协议配置尚未覆盖。[SecureCRT 官方导出说明](https://www.vandyke.com/products/securecrt/faq/)、[SecureCRT XML 生成示例](https://github.com/tonhe/moba2secure/blob/main/moba2secure.py)、[MobaXterm 书签格式及样例](https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea)。 |

测试入口包括 [分组与 SSH 变量](../desktop/terminal-groups.test.cjs)、[命令边界](../desktop/terminal-marks.test.cjs)、[剪藏](../scripts/verify-terminal-snippets.cjs) 和 [导入](../desktop/terminal-host-import.test.cjs)。官方参考包括 [现有主机导入](https://docs.termius.com/getting-started/import-existing-hosts)、[工作区](https://docs.termius.com/terminal/workspaces)、[剪藏](https://docs.termius.com/terminal/snippets) 和 [Shell 集成](https://docs.termius.com/terminal/autocomplete-and-shell-integration)。

## 账号、共享与日志

| 功能 | Brclio 测试版与验收边界 |
| --- | --- |
| 本地与个人库 | 支持仅本机使用；登录后可选择同步主机及转发模板，按账号分区、检查版本并处理冲突。 |
| 跨设备 | 桌面个人主机及转发模板可同步。个人剪藏和剪藏包有独立同步开关、按条目处理冲突。笔记、私钥文件、密码、日志、终端历史和布局均不在主机同步接口内。手机配对按用户先前指定的范围暂缓。 |
| 团队及多个库 | 测试接口可创建多个共享主机库，逐人邀请、接受、授予读/编辑权限、撤销、退出。成员必须由有效账号授权，私人主机不会因加入团队自动共享。 |
| 安全数据共享 | 可逐项分享主机名称、地址、SSH 用户名和端口。所有者与编辑成员也可从个人剪藏选取一条，在预览包名、模板和正文、核对成员及仓库可读范围后共享。接受邀请的只读成员可查看和存入个人剪藏，读取正文时重新校验成员权限。端到端加密的全量团队保险库与密钥共享尚缺。 |
| 实时协作、多人终端 | 共享主机库提供版本冲突检查。独立 beta Worker 支持双方同意后分享指定窗格的可见文本，见 [只读协作的边界与限额](../cloudflare/terminal-live-beta.md)。观看者可提交单行草稿，由主持人审阅、填入，并亲自按 Enter。公网部署和直接共享键盘控制尚缺。 |
| 本地会话记录 | 登录后在选定窗格手动开启，支持查看、按主机筛选、删除、设置时间保留策略。已有旧日志可在“本地或未记录主机”中查到。 |
| 书签 | 支持给日志选区或末尾添加书签、跳转；按时间清理时保留带书签的日志。 |
| 跨设备 / 团队日志 | 已停止的本机日志可逐份确认分享给个人账号或含该主机的共享库。独立口令在设备端加密正文和书签。可按主机和记录者筛选，读者只读，记录者和库主可删除副本。逐份设置 1、7、30、90 或 365 天访问期限，访问时清理过期记录，Git 历史可能保留密文。云端保留名称、主机、记录者和日期。库主可统一设置新副本最长留存天数，既有副本沿用原到期日。取回团队密文时记录账号、动作、副本编号和时间，库主可手动查看最近 64 条，客户端解密结果仅在本机可见。 |

参见 [存储与账号边界](terminal-account-sync.md)、[两账号共享验证](../scripts/verify-terminal-shared-vaults.cjs) 和 [会话日志验证](../desktop/terminal-local-logs.test.cjs)。官方参考包括 [团队库](https://docs.termius.com/team-collaboration/team-vaults)、[团队日志](https://docs.termius.com/team-collaboration/team-session-logs) 和 [密钥与密码同步](https://docs.termius.com/keychain/sync-of-keys-and-passwords)。

## 集成与企业功能

| 功能 | Brclio 测试版与验收边界 |
| --- | --- |
| AWS EC2、Azure VM、DigitalOcean Droplets | 使用当前设备已登录的官方 CLI，经用户确认读取清单，再选择要导入的主机。覆盖样例响应和映射；真实租户与持续自动更新待验。 |
| API Bridge | 可手动启用回环 HTTP 服务，每次开启生成新的会话令牌，15 分钟后失效，支持创建分组、创建和删除主机、读取个人库的连接清单；关闭视图、上锁、超时将停止。尚缺 Termius API 的完整请求模型与多库接口兼容性。 |
| Ansible | 可选取静态 inventory JSON 或 `ansible-inventory --list` 输出。支持嵌套组、子组引用和 `_meta.hostvars`，逐项勾选 SSH 主机，读取字面地址、端口和用户名。一个主机直接属于多组时，按名称排序后的第一组用作分组，其他组作为标签。还可复制本机静态清单。动态插件、Jinja 和 playbook 不在客户端运行；高级变量优先级可先由 Ansible 展开。Termius 的官方角色可通过其 API Bridge 创建、更新或删除其保险库中的主机，Brclio 暂未兼容该角色的自动账号写入流程。[Termius 官方 Ansible 角色](https://github.com/termius/ansible-role-api-bridge) |
| Vanta | 尚缺组织授权和合规数据连接，需 Vanta 测试租户。 |
| 2FA、SAML SSO、企业域名 | 应用使用现有 Brclio 登录机制。终端 PIN 与账号 2FA 独立。共享库可限制新成员使用已验证的指定邮箱域名；企业 SAML、账号级强制二步认证尚缺。 |
| 团队管理台 | 共享主机库提供逐库成员权限，库主可管理邀请域名和查阅本库最近 64 条管理记录；尚缺组织级策略和统一审计控制台。 |
| 审计报告、支持、合同和账单 | SOC 2 Type II 报告、专属客户经理、SLA、合并账单、支票/转账、采购订单及定制条款属于服务商资质或商业服务。 |
| AI、移动配对 | 沿用此前明确的范围，暂缓。 |

实现参考 [云资产映射](../desktop/terminal/cloud-inventory.cjs) 和 [本机 API 测试](../desktop/terminal-inventory-bridge.test.cjs)。官方参考包括 [Termius API Bridge](https://termius.com/api-docs/)、[AWS](https://docs.termius.com/integrations/aws)、[Azure](https://docs.termius.com/integrations/microsoft-azure)、[DigitalOcean](https://docs.termius.com/integrations/digitalocean) 和 [企业 SAML](https://docs.termius.com/administration/saml-sso)。
