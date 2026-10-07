# 桌面客户端与右键复制路径

Brclio 桌面端使用 Electron，Windows 与 macOS 共用 `core/path-engine.cjs`、设置模型和前端。文件选择框、剪贴板与系统右键入口由原生进程提供。设置保存在应用数据目录下的 `com.brclio.toolbox/settings.json`，避免与其它同名软件冲突；按写入顺序原子替换。首次使用默认复制绝对路径且不加引号。

## 启动与构建

```sh
npm install
npm start
npm run build:mac
npm run build:win
```

系统右键集成默认关闭。在软件内手动启用后，再从 Finder 或资源管理器调用。先将安装版放在固定位置，例如 macOS 的 `/Applications`；移动软件后重新启用集成可更新启动位置。开发模式也可测试集成，但其入口依赖本机 Electron 和当前源码目录，不适合分发。

## Windows

在当前用户的 `HKCU\Software\Classes` 下写入三个专用静态菜单项：

- `*\shell\Brclio.CopyPath`：文件。
- `Directory\shell\Brclio.CopyPath`：文件夹。
- `Directory\Background\shell\Brclio.CopyPath`：当前文件夹的空白处。

显示名称为“复制路径 · Brclio”。Windows 11 使用经典菜单中的“显示更多选项”。首版资源管理器入口按单个文件或文件夹工作，批量复制可在软件内多选或拖入。将 `MultiSelectModel` 设为 `Single`，避免资源管理器多次独立启动后互相覆盖剪贴板。

命令直接启动软件可执行文件，以独立参数传入路径，不经过 `cmd.exe`、PowerShell 或路径拼接执行。文件夹参数附加 `\.`，防止磁盘根目录结尾的反斜杠影响 Windows 命令行引号解析；主进程解析成正常绝对路径后格式化。

菜单用 `BrclioOwner=com.brclio.toolbox` 标记。启用前检查同名项归属，写入失败恢复此前配置；停用及 NSIS 卸载只清理带该归属标记的菜单项，不修改全局菜单样式，也不重启资源管理器。重新安装后若设置了开机启动，请在新安装位置检查开机启动设置。

## macOS

在当前用户的 `~/Library/Services/Brclio Copy Path.workflow` 安装 Automator 快速操作。选中文件或文件夹后，从右键菜单的“快速操作”或“服务”选择“复制路径 · Brclio”。此方式使用 Finder 选中项，不在 Finder 空白处提供菜单。

工作流使用系统“运行 Shell 脚本”动作并选择“作为参数”传入输入；固定程序位置使用 POSIX 引号处理，选中路径通过 `"$@"` 原样传递，文件名中的空格、中文、引号、`&`、`$()` 不作为脚本执行。工作流通过公开 AppKit `NSUpdateDynamicServices()` 刷新服务列表，不要求控制 Finder 的自动化权限。

菜单未显示时，请在系统设置中搜索“服务”或“Finder 扩展”，检查该快速操作是否启用；macOS 版本不同，相关开关的位置可能不同。安装状态表示工作流文件与当前软件位置一致，系统设置可能仍单独禁用此服务。停用集成会删除这个带 Brclio 标记的工作流。macOS 拖走 `.app` 不会触发卸载钩子，删除软件前可先在设置中停用集成；也可手动移除上述单个工作流。

## 软件关闭时也可使用

系统入口调用：

```sh
"/path/to/Brclio" --copy-path -- "/absolute/path/to/item"
```

软件会读取已保存设置、判断文件夹类型、生成路径文本并写入系统剪贴板。成功后不打开窗口；已有软件进程时，使用 `requestSingleInstanceLock` 的 `additionalData` 传递原始路径数组，由主进程完成复制。这样避开 Electron 第二实例 `argv` 的重排及额外 Chromium 参数。格式化失败时保留剪贴板内容，打开工具箱说明原因，用户可调整相对路径基准目录后重试。

“带引号”是路径文本的包裹规则，不代表可以把任何带引号路径直接当作终端命令执行。

## 原生桥与安全边界

`desktop/preload.cjs` 只公开 `window.brclio` 的固定方法：平台信息、设置、路径选择、复制文本、集成开关、软件更新及状态事件。文件拖放通过 Electron `webUtils.getPathForFile` 获得真实磁盘路径，并由主进程读取文件夹类型，不猜测浏览器虚拟文件名。渲染窗口启用上下文隔离、沙箱并关闭 Node 集成；IPC 仅接受本地首页的主 frame，拒绝外部导航、新窗口及 webview。

## 在线检查与下载安装

用户手动触发检查，客户端通过 Electron `net.fetch` 读取固定仓库 `Brclio/Brclio` 的 GitHub 最新正式 Release。不会后台自动下载，也不接受前端传入的更新地址或执行命令。仅选择当前处理器对应的固定文件名：

- `Brclio-<版本>-mac-arm64.dmg` 或 `Brclio-<版本>-mac-x64.dmg`。
- `Brclio-<版本>-windows-x64.exe`。
- 同一 Release 中的 `SHA256SUMS.txt`。

下载先写入用户数据目录 `updates/` 下的 `.part` 文件，显示字节数和进度。网络请求、空闲连接和总下载时间均有上限。下载完成后必须同时通过发布资产大小和 SHA256 校验；GitHub 提供资产 digest 时也需一致。失败会清理 `.part`，用户可点击重新下载。允许的 HTTPS 下载及重定向主机限定为 GitHub 官方服务。再次点击安装前重新计算文件 SHA256，防止下载后的文件变更。

macOS 安装按钮打开校验通过的 DMG，由用户将 Brclio 拖入 Applications 并替换旧版；这不表示自动安装完成。Windows 打开校验通过的安装器后退出当前软件，安装器继续引导。安装后的版本应在重新启动的软件内核对。

## 验证

```sh
node --test desktop/*.test.cjs
node desktop/smoke.cjs
```

单元测试覆盖命令行参数与特殊文件名、设置持久化与并发写入、损坏配置保留、Windows 当前用户注册表安装/移除/碰撞/失败回滚，以及 macOS 临时 Services 目录的安装/移除/位置变化。在 macOS 上还实际运行临时 Automator 工作流，验证中文及特殊文件名作为单个参数传递。更新测试使用模拟的正式 Release 和安装包，覆盖下载完整性、文件篡改、失败清理、重试和地址校验。

原生 smoke 测试在临时用户数据目录启动真实 Electron，检查本地桥、设置持久化、剪贴板、文件及文件夹元数据、第二实例和软件关闭时的命令行复制。测试结束会恢复原剪贴板的所有可读取格式。测试不向当前用户的真实 Finder 服务目录或注册表安装入口。

Electron 端到端测试可设置 `BRCLIO_USER_DATA` 为临时绝对目录来隔离偏好设置和单实例锁。安装包构建成功不代表目标系统验收成功；还需在对应 Windows/macOS 环境检查菜单可见性、软件关闭/运行两种状态的剪贴板结果、重启后的设置和卸载清理。

## 官方实现依据

- [Electron 单实例锁与第二实例参数](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)：精确参数应使用 `additionalData`。
- [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils)：通过 preload 获得磁盘文件真实路径。
- [Electron clipboard](https://www.electronjs.org/docs/latest/api/clipboard)：Electron 44 的异步剪贴板 API；复制成功在写入完成后返回。
- [GitHub 获取最新 Release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)：正式版本、资产与下载地址。
- [Microsoft 扩展快捷菜单](https://learn.microsoft.com/en-us/windows/win32/shell/context)：静态 verb、命令和路径引号。
- [Microsoft 创建快捷菜单处理程序](https://learn.microsoft.com/en-us/windows/win32/shell/context-menu-handlers)：当前用户 `HKCU\Software\Classes` 注册。
- [Microsoft Windows 11 应用体验规范](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/get-started/best-practices.md)：经典菜单通过“显示更多选项”访问。
- [Apple 创建 Automator 工作流](https://support.apple.com/guide/automator/create-workflows-aut7cac58839/mac)：快速操作用于 Finder、服务及快速操作菜单。
- [Apple 使用脚本动作](https://support.apple.com/guide/automator/use-scripts-aut4bb6b2b4f/mac)：系统“运行 Shell 脚本”动作。
- [Apple NSUpdateDynamicServices](https://developer.apple.com/documentation/appkit/nsupdatedynamicservices())：刷新动态服务。
