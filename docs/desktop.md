# 桌面客户端与右键复制路径

Brclio 桌面端使用 Electron，Windows 与 macOS 共用 `core/path-engine.cjs`、设置模型和前端。文件选择框、剪贴板与系统右键入口由原生进程提供。设置保存在应用数据目录下的 `com.brclio.toolbox/settings.json`，避免与其它同名软件冲突；按写入顺序原子替换。首次使用默认复制绝对路径且不加引号。

## 启动与构建

```sh
npm install
npm start
npm run build:mac
npm run build:win
```

系统右键集成默认关闭。在软件的“复制路径”页面点击“启用右键菜单”后，再从 Finder 或资源管理器调用。先将安装版放在固定位置，例如 macOS 的 `/Applications`；移动软件后重新启用集成可更新启动位置。macOS 和 Windows 11 的菜单需要完整安装版内的原生扩展，`npm start` 开发预览不会安装这两个系统的菜单。

## Windows

Windows 11（build 22000 及以上）使用原生 `IExplorerCommand` COM 扩展和 sparse identity package，菜单“复制路径 · Brclio”注册在第一层。包名固定为 `Brclio.Toolbox.Shell`，COM 类固定为 `{CFD1E4D4-3973-45D3-8542-45A77E6C58C9}`，身份包、公钥证书和 manifest 位于安装目录的 `resources/windows-shell/`，DLL 另放在其中的包版本子目录，避免升级时覆盖被 COM 宿主占用的旧文件。支持文件、文件夹、多选及文件夹空白处；多选只启动一次 Brclio，将整个选区交给现有复制流程，保留已保存的格式设置。

构建 Windows 安装包需要 Visual Studio C++ x64 工具链和 Windows SDK；`electron-builder` 的 afterPack 钩子自动编译静态 CRT 的 DLL、生成 MSIX 并签名。默认生成专用自签名代码签名证书；私钥及临时 PFX 构建后删除，只将公钥 `BrclioShell.cer`、已签名 MSIX 和限定操作的证书助手放入安装包。启用时验证签名公钥、证书用途、文件哈希和 Windows 原生签名校验结果，再通过标准 UAC 管理员授权将这个专用叶证书加入机器 `TrustedPeople`，满足 Windows 部署服务的签名信任要求；当前用户的包注册仍由原用户完成。助手内编译固定的公钥指纹，只能添加该公钥或清理具有 Brclio 归属记录、且没有用户仍在使用的专用证书。不会导入 Root 或更改开发者模式。已有的信任项保持原样，升级保留注册和信任。

已有 CA 签名证书也可通过 `BRCLIO_WINDOWS_SHELL_CERTIFICATE_FILE`、`BRCLIO_WINDOWS_SHELL_CERTIFICATE_PASSWORD`、`BRCLIO_WINDOWS_SHELL_PUBLISHER` 和可选 `BRCLIO_WINDOWS_SHELL_TIMESTAMP_URL` 提供给构建。Publisher 必须与证书 Subject 一致。不需要把私钥放进仓库。默认构建的私钥每次生成，因此更换安装包证书后需要再次授权；不具备管理员权限或企业策略禁止证书信任、AppX 注册时，会显示注册错误。

首次安装保持关闭。已启用旧版菜单的用户打开新版时会自动迁移；新版注册确认后才移除带 Brclio 归属标记的旧入口。注册失败时保留旧入口，不把它算作第一层菜单已启用。菜单可能需要重新打开资源管理器窗口，或注销后登录才能刷新，程序不会主动结束 Explorer。

Windows 10 继续在当前用户的 `HKCU\Software\Classes` 下写入三个专用静态菜单项：

- `*\shell\Brclio.CopyPath`：文件。
- `Directory\shell\Brclio.CopyPath`：文件夹。
- `Directory\Background\shell\Brclio.CopyPath`：当前文件夹的空白处。

显示名称为“复制路径 · Brclio”。Windows 10 的经典入口按单个文件或文件夹工作，批量复制可在软件内多选或拖入。将 `MultiSelectModel` 设为 `Single`，避免资源管理器多次独立启动后互相覆盖剪贴板。

命令直接启动软件可执行文件，以独立参数传入路径，不经过 `cmd.exe`、PowerShell 或路径拼接执行。文件夹参数附加 `\.`，防止磁盘根目录结尾的反斜杠影响 Windows 命令行引号解析；主进程解析成正常绝对路径后格式化。

菜单用 `BrclioOwner=com.brclio.toolbox` 标记。启用前检查同名项归属，写入失败恢复此前配置；停用及 NSIS 卸载只清理带该归属标记的菜单项，不修改全局菜单样式，也不重启资源管理器。重新安装后若设置了开机启动，请在新安装位置检查开机启动设置。

选择为所有用户安装时，Windows 11 卸载按账户核对包身份、COM 路径及实际外部目录，仅移除指向本次安装的现代包注册；无法确认归属或清理失败时，停止卸载以保留文件。更新会保留其他账户仍在使用的旧版扩展 DLL。Windows 10 经典注册表项及当前用户的证书存储仍只处理卸载账户，不加载其他账户的离线配置文件；其他账户的经典入口可能需要该账户自行停用。跨账户交互和 Windows 11 菜单实际可见性仍需桌面验收。

## macOS

从 v0.1.2 起，macOS 使用安装版内的 `Brclio.app/Contents/PlugIns/BrclioFinderSync.appex`。启用后，在 Finder **第一层右键菜单**选择“复制路径 · Brclio”。选中文件、文件夹或多个项目时复制选中路径；在文件夹空白处调用时复制当前文件夹路径。

Finder 顶部工具栏也提供复制图标：点击后选择“复制路径 · Brclio”，复制当前选中的一个或多个项目；未选中项目时，若 Finder 提供当前文件夹位置，则复制该文件夹路径。若 Finder 无法提供有效位置，菜单会显示不可点击的“请先选择文件或文件夹”。工具栏图标未显示时，可从 Finder 的“显示 → 自定义工具栏”添加“复制路径 · Brclio”（旧系统可能称“自定工具栏”）。两个入口使用同一套已保存的复制格式设置。

先将 Brclio 放入 `/Applications` 并打开，再在“复制路径”页面点击“启用右键菜单”。首次打开的 Gatekeeper 允许与 Finder 扩展批准是两个独立步骤：如果菜单仍未显示，请在系统设置中搜索“扩展”，允许 Brclio 的 Finder 扩展，再返回软件重新启用。不同 macOS 版本的分类可能为“Finder”或“文件提供程序”，通常位于“通用 → 登录项与扩展”。软件显示已登记或已启用，只表示注册与启用状态，仍需在实际 Finder 中检查菜单并试复制。

扩展通过公开 `NSWorkspace` API 向所在容器应用发送定向 URL 事件，携带选中的绝对路径；主应用沿用已保存的格式设置并写入剪贴板。容器位置从扩展所在的应用包确定，不依赖默认 URL handler，也不通过 shell 执行文件名。扩展具有独立 App Sandbox 权限，不申请控制 Finder 的自动化权限。

旧版安装的服务位于 `~/Library/Services/Brclio Copy Path.workflow`。新菜单启用成功或停用集成时，会自动移除其中带 `Contents/brclio-owner.json` 且 `owner` 为 `com.brclio.toolbox` 的旧工作流，避免残留重复入口。未标记或属于其它应用的同名工作流、其它 Services 均保留。停用新的集成会禁用 Finder 扩展。macOS 拖走 `.app` 不会触发卸载钩子，删除软件前可先停用右键菜单。

Finder Sync 提供的是受监控目录中的菜单扩展，不能保证所有 Finder 位置都显示。部分特殊 Applications 视图、虚拟目录或云盘视图可能受系统限制；多个扩展覆盖同一目录也可能冲突。普通实体目录、Desktop 和外置卷需要分别验证，根目录覆盖登记不代表所有位置均可用。[Apple DTS 对覆盖范围的说明](https://developer.apple.com/forums/thread/766680)

## 复制所选路径的快捷键

macOS 默认使用 `Option+P`，Windows 默认使用 `Alt+P`。在前台 Finder／资源管理器中选中文件或文件夹，按快捷键直接复制所有选中项的路径，沿用保存的引号、分隔符、相对路径等格式，不需要打开工具窗口。无选中项、虚拟项目或窗口已切换时，保留原剪贴板并提示原因。

打开“通用设置 → 复制所选路径”，点击“修改快捷键”后按下新的组合键，即时保存并生效；按 Esc 或点击取消保留原组合。“恢复默认”只重置复制快捷键，“复制路径”页面的恢复默认只重置路径格式。

快捷键在软件运行时生效，窗口最小化也可使用。macOS 关闭窗口后，只要未退出软件，仍可按快捷键复制；Windows 关闭最后一个窗口会退出软件，需要再次启动后才能使用快捷键。macOS 首次使用会请求允许 Brclio 控制 Finder，以读取当前选中项；若拒绝，可在“系统设置 → 隐私与安全性 → 自动化”中允许后重试。右键菜单与 Finder 工具栏的扩展无需此自动化授权。

支持 Control、Option / Alt、Command / Win 配合字母、数字、功能键等组合。修改时检查系统占用，无法注册时保留原设置并提示更换；启动时遇到占用也会在设置页显示，可点击重试或修改。录入时暂时释放当前组合，取消、离开窗口或重载后自动恢复。设置保存在本机，重启后沿用；退出时释放系统绑定。浏览器预览与 Android 不支持桌面全局快捷键。快捷键读取选中项使用固定的本地脚本和 JSON 数据，不把文件名拼入命令，不读取文件内容。

Windows 使用前台窗口中的可见活动视图读取选中项，不直接采用后台标签页缓存。无法确定活动视图或操作期间发生切换时会提示重试；Windows 11 客户端标签页切换需另行实机验收。桌面图标选区不属于资源管理器窗口入口。

## 软件关闭时也可使用

Windows 右键入口和桌面命令行复制使用：

```sh
"/path/to/Brclio" --copy-path -- "/absolute/path/to/item"
```

macOS Finder 扩展通过定向 URL 事件调用同一复制流程。主进程在应用启动早期接收 `open-url`，启动未完成时先排队处理，因此应用关闭和已运行两种状态均可使用。

软件会读取已保存设置、判断文件夹类型、生成路径文本并写入系统剪贴板。成功后不打开工具窗口；命令行启动遇到已有软件进程时，使用 `requestSingleInstanceLock` 的 `additionalData` 传递原始路径数组，由主进程完成复制。这样避开 Electron 第二实例 `argv` 的重排及额外 Chromium 参数。格式化失败时保留剪贴板内容，打开工具箱说明原因，用户可调整相对路径基准目录后重试。

“带引号”是路径文本的包裹规则，不代表可以把任何带引号路径直接当作终端命令执行。

## 原生桥与安全边界

`desktop/preload.cjs` 只公开 `window.brclio` 的固定方法：平台信息、设置、路径选择、复制文本、集成开关、快捷键录入与状态、软件更新及状态事件。文件拖放通过 Electron `webUtils.getPathForFile` 获得真实磁盘路径，并由主进程读取文件夹类型，不猜测浏览器虚拟文件名。渲染窗口启用上下文隔离、沙箱并关闭 Node 集成；IPC 仅接受本地首页的主 frame，拒绝外部导航、新窗口及 webview。

## 在线检查与下载安装

用户手动触发检查，客户端通过 Electron `net.fetch` 读取固定仓库 `Brclio/Brclio` 的 GitHub 最新正式 Release。不会后台自动下载，也不接受前端传入的更新地址或执行命令。仅选择当前处理器对应的固定文件名：

- `Brclio-<版本>-mac-arm64.dmg` 或 `Brclio-<版本>-mac-x64.dmg`。
- `Brclio-<版本>-windows-x64.exe`。
- 同一 Release 中的 `SHA256SUMS.txt`。

下载先写入用户数据目录 `updates/` 下的 `.part` 文件，显示字节数和进度。网络请求、空闲连接和总下载时间均有上限。下载完成后必须同时通过发布资产大小和 SHA256 校验；GitHub 提供资产 digest 时也需一致。失败会清理 `.part`，用户可点击重新下载。允许的 HTTPS 下载及重定向主机限定为 GitHub 官方服务。再次点击安装前重新计算文件 SHA256，防止下载后的文件变更。

从 v0.1.3 起，“下载并安装更新”连续执行下载和安装。macOS 只读挂载 DMG，校验应用身份、版本、架构、完整签名和 Finder 扩展沙盒；在当前安装父目录复制并复验完整新版，然后启动独立助手。助手就绪且获得一次性确认后，旧客户端才退出。助手通过整包重命名保留旧版、安装新版，避免逐文件覆盖已签名代码。下载缓存和设置始终位于应用包外。

Windows 助手备份当前安装及匹配的安装记录，静默运行 NSIS 覆盖当前目录，并恢复属于 Brclio 的右键菜单。安装程序退出码及文件版本正确后启动新版。安装目录不可写时会在旧客户端退出前失败，不主动提权。

两端均等待新版界面成功初始化后的私有启动确认，匹配任务令牌、目标路径、版本及真实进程，之后才认定成功并清理备份。启动未确认时尝试恢复并重新打开旧版，清理失败仅保留备份并提示。macOS 保留原 Finder 扩展启用状态；不关闭 Gatekeeper、不移除 quarantine、不重启 Finder。系统安全提示可能阻止未公证软件启动。

v0.1.2 及更早版本没有上述覆盖安装模块，需退出旧版后手动安装 v0.1.3 一次，后续更新使用新流程。首次从 DMG 运行也应先将应用移到可写的固定应用目录。

## 验证

```sh
node --test desktop/*.test.cjs
node desktop/smoke.cjs
node native/macos/test.mjs  # macOS：Finder 扩展的独立原生测试
node native/windows/test.cjs  # Windows：编译 DLL、身份包与 COM 调用测试；macOS/Linux 只测试命令行编码
```

单元测试检查命令行参数与特殊文件名、设置持久化与并发写入、损坏配置保留、Windows 当前用户注册表安装/移除/碰撞/失败回滚。macOS 集成测试使用隔离目录和替身命令检查 Finder 扩展注册、启用状态与旧 Services 的归属清理；原生测试检查菜单选择和路径 URL 编解码。这些测试不会启用本机 Finder 扩展。更新测试使用模拟的正式 Release 和安装包，检查下载完整性、文件篡改、失败清理、重试和地址校验。

原生 smoke 测试在临时用户数据目录启动真实 Electron，检查本地桥、设置持久化、剪贴板、文件及文件夹元数据、第二实例和软件关闭时的复制调用。测试结束会恢复原剪贴板的所有可读取格式。测试不向当前用户注册、启用 Finder 扩展或安装注册表入口。

Electron 端到端测试可设置 `BRCLIO_USER_DATA` 为临时绝对目录来隔离偏好设置和单实例锁。安装包构建、签名检查和扩展注册成功不代表目标系统验收成功；还需在对应 Windows/macOS 环境检查菜单可见性、软件关闭/运行两种状态的剪贴板结果、重启后的设置和卸载清理。macOS 应实际右键文件、文件夹、多选和空白处，确认第一层菜单及格式设置生效；还应在工具栏检查图标、单选和多选复制、无选区时的当前文件夹回退，以及无法取得有效位置时的禁用提示，并验证停用后两个入口均消失。

## 官方实现依据

- [Electron 单实例锁与第二实例参数](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)：精确参数应使用 `additionalData`。
- [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils)：通过 preload 获得磁盘文件真实路径。
- [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)：应用就绪后注册系统快捷键，检查占用并在退出时释放。
- [Electron clipboard](https://www.electronjs.org/docs/latest/api/clipboard)：Electron 44 的异步剪贴板 API；复制成功在写入完成后返回。
- [GitHub 获取最新 Release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)：正式版本、资产与下载地址。
- [Microsoft 扩展快捷菜单](https://learn.microsoft.com/en-us/windows/win32/shell/context)：静态 verb、命令和路径引号。
- [Microsoft 创建快捷菜单处理程序](https://learn.microsoft.com/en-us/windows/win32/shell/context-menu-handlers)：当前用户 `HKCU\Software\Classes` 注册。
- [Microsoft Windows 11 应用体验规范](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/get-started/best-practices.md)：经典菜单通过“显示更多选项”访问。
- [Microsoft Windows 11 原生菜单扩展](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer)：`IExplorerCommand`、COM surrogate 和三种文件管理器上下文。
- [Microsoft 外部位置身份包](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps)：sparse package 签名与 ExternalLocation 注册。
- [Apple Finder Sync 扩展](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Finder.html)：受监控目录中的 Finder 菜单和选中项。
- [Apple 扩展的签名、启用和分发](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html)：容器与扩展的签名方式及用户批准。
- [Apple NSWorkspace 定向打开 URL](https://developer.apple.com/documentation/appkit/nsworkspace/open(_:withApplicationAt:configuration:completionHandler:))：向指定容器应用传递复制路径事件。
- [Apple 沙盒调用者的命令行参数限制](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/arguments)：Finder 扩展不依赖会被忽略的 `arguments`。
