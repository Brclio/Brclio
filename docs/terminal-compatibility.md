# Brclio 桌面终端与 iTerm2 3.7.6

核对日期为 2026-11-28。基准固定为 iTerm2 3.7.6（2026-10-15 构建）。上游程序面向 macOS，Brclio 使用 xterm.js 渲染，使用 node-pty 连接本机的 Unix PTY 或 Windows ConPTY。下表核对 Brclio 工作树中的可观察行为。官网文档持续更新，新版本独有功能不能据此计入 3.7.6。[固定版本说明](https://raw.githubusercontent.com/gnachman/iTerm2/v3.7.6/README.md) · [官方版本记录](https://iterm2.com/downloads.html) · [Brclio 终端入口](../desktop/terminal/terminal.js) · [PTY 实现](../desktop/terminal/pty.cjs)

“可用”表示有可操作入口和对应实现，只涵盖该行列出的行为。“部分”指出仍有明确差距。“待实测”表示已有底层支持，但还缺少目标平台上的专门验收。“未实现”表示尚无相应的终端入口或协议实现。“本轮暂缓”表示用户已确认先做桌面能力，暂缓 AI 和手机配对。单项测试通过与全平台等价分别记录。目标平台为 Windows x64、macOS Intel 和 macOS Apple silicon。

## 官网功能清单

下表按官方功能页的顺序逐项列出。复查时应从 Brclio 主窗口进入终端，在新窗格中操作。[上游功能页](https://iterm2.com/features.html) · [Brclio 终端操作面板](../desktop/terminal/index.html)

| iTerm2 功能 | Brclio 状态 | 可复查的行为与差距 |
| --- | --- | --- |
| 分屏 | 可用 | 在同一标签先左右、再上下分屏，分别输入不同文本。拖动分隔条检查 PTY 的宽高，也可最大化窗格、按方向移动焦点，或给同一标签中明选的多个窗格广播键盘输入。每个终端工作区最多运行 32 个本地 PTY 会话。 |
| 全局热键窗口 | 部分 | 在终端操作中录入单独的系统快捷键，移到另一个应用后用它显示或隐藏终端；可清除热键，原有复制路径快捷键有冲突检测。贴屏动画、多个独立热键配置和切换应用后自动收起尚缺。 |
| 窗格内查找 | 可用 | 查找同一文本的多个匹配，切换大小写、整词和正则，查看计数并前后跳转。 |
| 自动补全 | 部分 | 输入刚刚输出的单词前缀，在“从滚动记录补全”中选择。候选来自当前窗格，最多 50 项。按主机或使用频率排序的命令建议尚缺。 |
| 键盘复制模式 | 部分 | 用方向键定位，Shift 扩选，Enter 复制，Esc 退出。尚未覆盖上游全部 Vim 键位、选择形状和移动粒度。 |
| 粘贴历史 | 部分 | 在某一窗格开启记录后，已粘贴文本可选择并再次粘贴。仅保留最近 20 条，每条最多 4096 个 UTF-16 码元。关闭记录或窗格时清空。跨会话复制历史及持久保存尚缺。 |
| 即时回放 | 部分 | 开启临时记录，输出或滚动几次后拖动时间轴查看文字快照。每窗格最多 120 帧并受总容量限制。颜色、图片、光标及逐帧画面还原尚缺。 |
| 可配置性 | 部分 | 可保存 Shell、起始目录、字体、历史行数、光标、对比度和颜色等参数，并读取 XML 格式的 .itermcolors。终端内可另设受支持操作的快捷键。完整配置导入、所有键映射动作及鼠标动作编辑尚缺。 |
| Unix 风格交互 | 部分 | 可启用焦点跟随鼠标和选中即复制，可用快捷键管理标签及分屏。跨平台中键粘贴、修饰键映射和原生选择行为未全验收。 |
| 24 位色彩 | 可用 | Windows x64 和两种 macOS 架构的打包应用均已实测。前台程序通过真实 PTY 指定 24 位前景和背景，测试分别核对显示文字的 RGB 值。 |
| 可读性 | 部分 | 修改最低对比度、光标形状、文本及光标颜色，观察低对比度输出。上游智能光标取色策略尚未比对。 |
| 鼠标事件上报 | 部分 | 在 Windows x64 和两种 macOS 架构的打包应用中，前台程序启用 SGR 鼠标模式后能从 PTY 读回点击坐标。程序关闭鼠标模式后，双击可选词，Brclio 复制按钮取得所选文本。拖动、滚轮、其他鼠标协议及其他 TUI 的交互还需分别验收。 |
| 系统通知 | 部分 | 可配置终端 BEL 的系统通知，通知最多每十秒一次，点击时可打开终端。作业结束、活动和静默等独立通知条件尚缺。系统通知展示取决于通知权限。 |
| 全局搜索 | 部分 | 在不同标签输出独特文字，从“搜索所有窗格”定位结果。当前搜索打开的终端缓冲区，最多显示 50 项。会话归档及元数据查询尚缺。 |
| 带标签的配置 | 部分 | 创建两个带标签的命名配置，按名称或标签筛选并载入。最多保留 64 个。上游结构化查询语法和配置层级尚缺。 |
| 多语言文字 | 部分 | 渲染端启用 Unicode 11 字宽表，可验收中文、全宽字符、组合音标、emoji 和 IME。未覆盖上游 Unicode 版本、字素簇、双向文字及字体组合的全部差异。 |
| 触发器 | 部分 | 保存正则并产生换行输出，可高亮行、加标记、响铃或捕获文本；匹配在有超时限制的 Worker 中进行。上游全部匹配模式、跨行匹配及动作类型尚缺。 |
| 智能选择 | 部分 | 四击或按住 Alt/Option 双击路径、网址、电邮或引号中的文本，检查选区。用户自定义识别规则和上下文动作尚缺。 |
| Shell 集成 | 部分 | 在新会话启用后可按提示符跳转，支持完整命令边界的 Shell 可选取输出；另可手动添加标记。各 Shell 的覆盖范围见下表。按主机记录命令、常用目录与远端上传下载尚缺。 |
| 自动切换配置 | 部分 | 配置主机与目录前缀规则，让 OSC 7 或 OSC 1337 的 RemoteHost/CurrentDir 元数据切换窗格外观；离开匹配范围时恢复此前外观。按运行进程、用户及上游匹配优先级切换尚缺。 |
| 行内图片 | 部分 | 有针对 iTerm2 单段内联 PNG 和 SIXEL 的像素测试。动画 GIF、Kitty 图形、多段文件传输或其他文件预览均不计入已验证范围。 |
| 逐行时间戳 | 部分 | 启用记录后产生数行新输出，移动指针到目标行查看时间。每窗格记录最多 1000 个非空行标记，基于换行和当前光标行的变更。任意位置光标重绘、旧缓冲区及全屏应用中的逐行变化尚未覆盖。 |
| 密码管理器 | 部分 | 在终端操作中点击「解锁终端密码库」，可新增、更新和删除专属条目。Electron safeStorage 分别加密名称与密码，使用 macOS 钥匙串或 Windows DPAPI 保护密钥。点「填入当前窗格」并核对程序、PID 和会话编号后，单行密码直接进入一个窗格，不附加回车。目标程序可能回显输入，回显内容可能出现在屏幕记录中。上游自动识别密码提示尚缺。 |
| 高级粘贴 | 部分 | 在预览中编辑内容、移除结尾换行、把制表符转为空格或把 UTF-8 转成 Base64，可设置逐行间隔并停止。上游全部转义、Shell 引用和转换组合尚缺。 |
| 选区批注 | 部分 | 在普通缓冲区给选区起始行或当前行写批注，再从列表定位或删除。每窗格最多 128 项。多行选区的精确范围及归档持久化尚缺。 |
| 会话徽章 | 部分 | 按窗格设置模板，使用 {host}、{dir}、{shell}、{tab} 显示已知元数据。Git 变量、上游表达式和样式设置尚缺。 |
| 输出捕获 | 部分 | 正则触发器可以捕获输出，列表可跳转至仍在缓冲区中的源行，最多保留 200 项。捕获分组、逐项状态和双击后执行协进程等上游行为尚缺。 |

## 文档中的其他核心主题

同一主题的设置和协议共享一行。下列复查条件用于区分外观近似、同一进程继续运行、重开新进程和真正的协议兼容。[上游文档目录](https://iterm2.com/documentation.html) · [固定版本功能索引](https://raw.githubusercontent.com/gnachman/iTerm2/v3.7.6/README.md)

| 主题 | Brclio 状态 | 验收条件、现有实现及平台差异 |
| --- | --- | --- |
| 终端入口、标签与快捷键 | 部分 | 终端可在主窗口和弹出窗口间移动，原 PTY 和缓冲区保留。可创建、重排、重命名、切换、关闭标签，可筛选终端操作。终端内的快捷键编辑器可给支持的动作改键。上游全部菜单、动作种类、键序列和每个配置独立的映射尚缺。 |
| 布局保存与重建 | 部分 | 用名称保存分屏树、比例和 Shell 启动配置，重新打开时在现有标签之外创建新会话。可验证原标签仍可输入，布局中的进程具有新 PID。 |
| 崩溃后恢复原会话 | 未实现 | 普通本地 PTY 服务随所属宿主退出，重新打开布局会启动新 Shell。专用 tmux 工作区另有服务器端持久化与手动重连，见下节。 |
| 隐藏会话、标签分组 | 部分 | 可在工作区中隐藏仍在运行的标签，按名称或从空白页单独找回；可按组名收起和展开标签。现有 PTY 随标签保留。分组属于当前工作区，跨窗口布局恢复、持久化和上游全部分组行为尚缺。 |
| 会话归档、笔记与剪藏 | 部分 | 可导出纯文本、ANSI 或静态 HTML，亦可跨会话创建、修改和删除命名剪藏及笔记，再主动粘贴到单一活动窗格。打开上游会话归档、完整还原归档界面，以及笔记自动绑定具体会话尚缺。 |
| 状态栏与会话状态 | 部分 | 可逐项显示或隐藏会话名、Shell、PID、最近上报的目录（或起始目录）、终端行列数、时钟和退出结果。命令退出码依赖 Shell 集成。Git 分支、资源图表、自定义脚本组件和应用上报的任务状态尚缺。 |
| 快速打开 | 部分 | 可按标签名、窗格标题、已上报的主机、目录或徽章筛选并激活窗格。按历史命令与其他对象综合排序的上游启动器尚缺。 |
| 字体与无障碍 | 部分 | 可选字体与字号，启用 xterm.js 屏幕阅读器模式。须分别验收 VoiceOver、Narrator、连字、回退字体和全宽字元。 |
| 选择命令及命令链接 | 部分 | 可从保存的命令边界选取输出。尚无对应上游的命令 URL、指定历史命令重新定位或分享命令选择。 |
| 动态配置 | 部分 | 可在系统文件对话框选取 iTerm2 JSON 的 Profiles 数组，按 Guid 跟踪命名配置。支持 Name、Tags、Normal Font、Scrollback Lines、Blinking Cursor 和 RGB 配色。最多读取 64 项、单文件 256 KiB。颜色映射 RGB 通道，字体名称配 8–40 的字号并取整。可选跟踪单份文件；同 Guid 改名或变更外观会更新已绑定窗格，格式错误保留上次结果。退出后保存上次导入的外观，需再次选文件才恢复跟踪。目录监控、多文件合并、XML/二进制 plist、父配置继承、写回及命令字段尚缺。 |
| tmux 控制模式 | 部分 | 通过专用入口连接或创建命名会话，在 Brclio 内分屏、切换窗口和分离再连接。macOS 使用真实 tmux -CC；Windows 使用 WSL 中的 tmux -C 管道。详情及实测边界见下节。 |
| SSH 集成与远端文件 | 部分 | 可保存 SSH/SFTP 目标和端口，明确点击连接后以独立 PTY 启动系统 OpenSSH 客户端，认证由其处理。SFTP 是交互式客户端。尚无 iTerm2 的 SSH 专用 framing、远端自动 Shell 钩子、图形文件传输及会话重连。 |
| 协进程 | 未实现 | 尚无向独立本地子进程转接指定会话输入输出并管理其生命周期的用户入口。 |
| 配套命令行工具 | 部分 | 已支持的内联图片、标记控制序列可由客户端程序输出。上游 it2、imgcat 等命令、远端文件传输及安装工具没有随 Brclio 分发。 |
| 私有转义序列 | 部分 | 支持 OSC 133 的 A/B/C/D、OSC 1337 的 SetMark、CurrentDir、RemoteHost 和部分图片序列。文件传输、用户变量、块折叠和自定义按钮等协议均未完整实现。 |
| 外部 URL Scheme | 未实现 | 尚无 iTerm2 风格的终端深链接处理、按会话或配置定位的复现用例。 |
| Python API、表达式与脚本变量 | 未实现 | 尚无兼容 iTerm2 Python 客户端的 API、订阅、状态栏组件，或上游表达式求值环境。 |
| AppleScript、Touch Bar | 部分 | Mac 终端获得焦点时可提供新标签、左右与上下分屏、查找和操作五个 Touch Bar 按键，Windows 可用窗口工具栏及键盘执行同样操作。当前验收机 iMac 没有 Touch Bar，实体硬件交互尚待实测。iTerm2 AppleScript 字典及对应的 Windows 自动化接口尚缺。 |
| 浏览器配置与浏览窗格 | 未实现 | 终端工作区尚无导航网页、维护浏览历史并与终端共享分屏的浏览器会话类型。 |
| AI 对话与 Claude Code 集成 | 本轮暂缓 | 单独的终端内对话、会话上下文关联及工具状态协议尚缺。Shell 中运行已有命令行程序不代表这些集成已经实现。 |
| 桌面工作组 | 未实现 | 尚无工作组模板及主从会话的协作生命周期。 |
| iTerm2 Buddy 手机配对 | 本轮暂缓 | 用户选择优先桌面终端。本轮不包含伴随应用、移动设备配对或手机联动验收。 |

## tmux 与 SSH 验收范围

在“操作 → tmux 控制模式”中连接或创建命名会话，本机 tmux 窗口映射为工作区标签，窗格映射为独立终端视图。可在会话中创建窗口、横向或纵向分屏，选择窗格并输入、调整工作区大小，随后分离并重新连接。正常分离只关闭控制客户端，进程由 tmux 服务端管理。工作区最多显示 64 个窗格并限制总单元格数。普通 Shell 中启动的 tmux、通过任意 SSH 会话输入的 -CC、上游 dashboard、所有历史行/备用屏幕模式的精确恢复，以及与普通 Brclio 标签间任意拖放均未覆盖。[上游 tmux 集成](https://iterm2.com/documentation-tmux-integration.html) · [tmux 控制协议](https://github.com/tmux/tmux/wiki/Control-Mode) · [工作区实现](../desktop/terminal/tmux-workspace.js)

| 环境 | 已验证的行为与待测边界 |
| --- | --- |
| macOS | 本机使用 tmux 3.8 和独立套接字验证了 DCS 1000p、协议响应、指定窗格的输入及尺寸，以及分离后仍可连回原进程。Intel 和 Apple silicon 打包应用的 Electron 测试均完成两个窗口、三个窗格、独立输入、分离并重连后再次读取原有输出。 |
| Windows | Windows Server 2022 x64 打包应用通过 wsl.exe 连接默认的 WSL 1 Alpine 3.22。真实 tmux -C 通过管道收发，协议没有 -CC 的 DCS 外层。测试在两个窗口、三个窗格中核对输入隔离、分离及重连后的原有输出。WSL 2、其他发行版及没有 WSL 的主机未获相同验证。此入口需要发行版内已安装 tmux。 |
| SSH / SFTP | 系统 OpenSSH 的 ssh 和 sftp 已通过本机回环测试。两个客户端读取临时的 Host 别名和端口配置，向 127.0.0.1 建立连接并交换 SSH 版本标识，随后测试服务端主动关闭。该用例尚未覆盖主机密钥、用户认证、远端 Shell 或 SFTP 文件传输。 |
| 密码库与系统密钥 | Windows x64 的打包和开发应用均使用原生 DPAPI 对随机生成值成功加密和解密。密码库界面另以独立测试密钥及生成的密码核对定向填入。macOS UI 测试沿用独立测试密钥，个人钥匙串授权和升级后能否继续解密仍待实测。现有 macOS 安装包使用临时签名，升级后钥匙串可能再次请求授权。 |

升级这一部分时可对照同一提交的实现与测试。[tmux 协议和传输测试](../desktop/terminal-tmux.test.cjs) · [真实 Electron tmux 测试](../scripts/verify-terminal-tmux.cjs) · [SSH 启动测试](../desktop/terminal-remote.test.cjs) · [上游 SSH 启动与集成说明](https://iterm2.com/documentation-preferences-profiles-general.html)

## 各 Shell 的命令标记

启动集成默认关闭，在“操作”中开启后创建新的会话。辅助脚本随桌面包本地分发，运行时不写用户启动文件。程序也可以自行输出协议标记。命令输出选择要求收到 C 与 D，一条手动标记只提供导航。记录限于当前窗格普通缓冲区，最多 512 项，滚动清理后旧标记失效。[上游 Shell 协议](https://iterm2.com/documentation-escape-codes.html) · [上游 Shell 集成](https://iterm2.com/documentation-shell-integration.html) · [本地实现](../desktop/terminal/command-marks.js)

| 环境 | 可验证行为与限制 |
| --- | --- |
| macOS zsh | 登录模式加载原有 .zshenv、.zprofile、.zshrc、.zlogin。precmd/preexec 提供命令结束与输出边界。实际 PTY 回归覆盖带单引号的路径、定制 prompt、上一条命令返回 23、下一条命令读到 23 以及退出码 19。 |
| macOS / Linux Bash | macOS 系统 Bash 3.2 支持提示符导航，并用提示符的命令编号核实用户已提交的可见单行输入。Bash 4.4 及以上通过 PS0 补充命令开始边界。两种 Mac 架构与 Ubuntu 的真实 PTY 回归验证了原登录文件及提示符、原有 PROMPT_COMMAND 与下一条命令均收到退出状态 23，Shell 最终以 19 退出。用户启动文件重置这些变量时可能不产生标记。Linux 验收限于该后端测试。 |
| Windows PowerShell / PowerShell 7 | 继续加载本机配置。支持时包装现有 prompt 与 PSConsoleHostReadLine。无 PSReadLine 时只标记提示符；执行策略及受限语言模式可能阻止启动集成。Windows x64 原生回归已验证自定义提示、读取器、成功/失败标记及原生命令退出码。完整 ConPTY/PSReadLine 组合需按系统版本实测。 |
| Windows cmd.exe | 保留原有 PROMPT 并加入提示符首尾标记。缺少可靠的命令执行前后钩子，默认无法自动划定命令输出范围。 |
| 其他登录 Shell、嵌套 Shell、SSH | 本地会话仍按原 Shell 启动。若相应 Shell 自行发送兼容控制序列，渲染器可处理。fish、tcsh、xonsh 和远端安装不在内置辅助脚本覆盖范围。 |

提交 `004e56c` 的 Windows 作业包含 PowerShell 命令边界、DPAPI、WSL 1 和打包界面测试。两项 Mac 作业包含 zsh、Bash、打包界面及原生 tmux。Ubuntu 作业运行 Bash 与 OpenSSH 回环回归。真实 PTY 的 RGB、鼠标和复制断言均在三个打包应用中运行。[Windows x64](https://github.com/Brclio/Brclio/actions/runs/46110241147/job/140872765930) · [macOS Intel](https://github.com/Brclio/Brclio/actions/runs/46110241147/job/140872766167) · [macOS Apple silicon](https://github.com/Brclio/Brclio/actions/runs/46110241147/job/140872765736) · [Ubuntu](https://github.com/Brclio/Brclio/actions/runs/46110241147/job/140872766000)

## 复查方法

1. 在项目根目录运行 `npm ci`，再运行 `node --test desktop/terminal-*.test.cjs`。Windows 可在 Git Bash 中执行，或显式传入测试文件。真实 PTY 用例使用临时工作目录。[PTY 测试](../desktop/terminal-pty.test.cjs) · [命令标记测试](../desktop/terminal-marks.test.cjs) · [布局测试](../desktop/terminal-arrangements.test.cjs) · [动态配置读写测试](../desktop/terminal-dynamic.test.cjs)
2. 在 macOS 或 Windows 上运行 `npm run sync` 和 `node scripts/verify-terminal.cjs`。用 `BRCLIO_SMOKE_EXECUTABLE` 指向当前架构已打包的可执行文件，可复查发行布局及原生模块。UI 测试覆盖的具体交互以脚本断言为准。[桌面端到端测试](../scripts/verify-terminal.cjs) · [图片与 Unicode 像素测试](../scripts/verify-terminal-output.cjs) · [真彩色、鼠标与复制测试](../scripts/verify-terminal-devices.cjs) · [动态配置界面测试](../scripts/verify-terminal-dynamic.cjs)
3. 在已安装 tmux 的 macOS 或默认 WSL 发行版已安装 tmux 的 Windows 上运行 `node scripts/verify-terminal-tmux.cjs`，可用同一环境变量改测打包应用。脚本使用独立套接字目录并验证实际命名会话、窗格和重新连接。
4. 三平台构建由同一工作流分别检查，看对应提交的 Windows x64、macOS Intel、macOS Apple silicon 三项结果。较早版本的通过记录只能证明该次构建。[打包验收工作流](../.github/workflows/desktop-terminal.yml)
