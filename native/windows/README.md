# Windows 11 资源管理器菜单

`BrclioExplorerCommand.dll` 实现 `IExplorerCommand` 和 `IObjectWithSite`。稀疏 MSIX 用 `windows.comServer`（STA COM surrogate）及 `windows.fileExplorerContextMenus` 将文件、文件夹和文件夹空白处注册到 Windows 11 一级右键菜单。菜单的具体顺序仍由 Windows 决定。

```sh
node scripts/windows-build-shell.cjs --arch x64 --version 0.1.6 --output native/windows/build/x64
node native/windows/test.cjs
node --test native/windows/build.test.cjs
```

完整构建需要 Windows、Visual Studio C++ x64 工具及 Windows 10/11 SDK。`scripts/windows-after-pack.cjs` 将结果写入 `<install>/resources/windows-shell/`，供 Electron 打包钩子调用；该目录在 `app.asar` 外。Windows 版本目前仅支持 x64，构建不注册菜单、不更改系统策略、不向信任证书存储写入。

输出包含版本目录中的 `<package-version>/BrclioExplorerCommand.dll`、`AppxManifest.xml`、仅含标识清单的 `BrclioShell.msix`、公开叶证书 `BrclioShell.cer`、图标，以及记录版本、架构、SHA-256、签名者信息的 `shell-build.json`。包的外部位置必须指向安装目录，清单中的可执行文件、DLL 和图标均相对该位置解析。DLL 使用独立版本目录，使新版安装不会覆盖仍被旧 COM surrogate 加载的旧版 DLL。

默认构建生成一个仅用于该次构建的 Brclio 自签代码签名叶证书，用它签署 DLL 和 MSIX。私钥仅存在于临时内存/临时 PFX，构建结束或失败后删除；安装文件中只包含公开证书。此证书不会因为“已签名”自动被 Windows 信任。运行时注册流程必须验证 MSIX 的实际签名和随附公开证书，并按产品的启用流程处理当前用户的证书信任；构建元数据不能代替签名验证。

生产证书也可通过 `BRCLIO_WINDOWS_SHELL_CERTIFICATE_FILE` 和可选的 `BRCLIO_WINDOWS_SHELL_CERTIFICATE_PASSWORD` 指定。该路径应指向构建环境中已有的 PFX，不能提交或打包私钥。`BRCLIO_WINDOWS_SHELL_PUBLISHER` 可覆盖默认 `CN=Brclio`，必须与证书 Subject 一致；`BRCLIO_WINDOWS_SHELL_TIMESTAMP_URL` 可配置 RFC 3161 时间戳服务。外部证书构建还通过 SignTool 验证证书链。

固定标识：包名 `Brclio.Toolbox.Shell`，应用 ID `Brclio`，CLSID `{CFD1E4D4-3973-45D3-8542-45A77E6C58C9}`，Verb ID `BrclioCopyPath`（清单只允许字母和数字）。升级时应保留包名、Publisher 和 CLSID。

调用菜单后，扩展一次性取得选区中的 `SIGDN_FILESYSPATH`，通过 `CreateProcessW` 启动相对 DLL 位置解析出的 `Brclio.exe --copy-path -- <paths>`，复用应用已有的格式设置与剪贴板实现。不调用 shell，不读取选中文件内容。支持 Unicode、多选和驱动器根目录；最多 1000 项，同时受 Windows 32,767 个 UTF-16 字符的进程命令行限制。超过限制会拒绝整组选区，避免只复制部分路径。空白处使用站点链的 `IFolderView` / `IPersistFolder2` 取得当前文件夹，不把聚焦文件误当成当前文件夹。

原生命令行测试可在 macOS/Linux 运行。Windows 下同一命令还编译真正的 DLL，直接激活其 COM 类，用模拟文件夹站点和真实 Shell 项验证多选、Unicode、驱动器根目录、空白处路径、生命周期，以及子进程真正收到的参数；它不安装包、不导入信任、不操作 Explorer。直接激活测试通过仍不能证明 Windows 11 菜单实际显示，发布前还需在安装后的 Windows 11 中检查菜单及剪贴板结果。

在隔离的 Windows CI 中可显式设置 `BRCLIO_ALLOW_SHELL_TRUST_SMOKE=1` 再运行该测试：它临时将本次构建的公开叶证书添加到当前用户 `TrustedPeople`，验证 DLL 与 MSIX 的真实 Authenticode 状态，并在 `finally` 中撤回本次新增的信任；预先存在的信任会保留。该测试不注册 Appx 包，不写入 Root 存储，也不修改开发者模式。

Microsoft 参考：[Explorer 菜单注册](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer)、[IFolderView.GetFolder](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifolderview-getfolder)、[CertificateRequest.CreateSelfSigned](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.certificaterequest.createselfsigned)。
