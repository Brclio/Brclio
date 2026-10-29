# 小红书客户端工具

Brclio 的「全部工具」与侧栏新增「小红书工具」，分为单篇下载、主页批量、实况合成三个页签。源项目为 `Brclio/brclio-xhs-media-downloader`，迁移基线提交 `a818212fc0d4450f8cf192e644cdc2f39103e810`；功能模块保留来源，界面沿用 Brclio Design System。

本次为 0.2.0 客户端集成与发布。安装包打包、GitHub Release 发布、隔离安装升级和真实小红书账号下的线上下载分别验收，不能用本地测试代替发布证明。

## 功能范围

| 功能 | 行为 |
| --- | --- |
| 单篇解析 | 完整分享文案、长链接、短链接与原图链接；桌面本地 Node / Python 双引擎；Android 本地解析及源官方公开接口的在线 Python 备用解析 |
| 原图 | 缩略图与大图查看、选择、全选/反选、单张/多张保存、复制原图文件与链接；Android 可分享所选原图 |
| 文案 | 完整正文、复制、TXT、整篇目录内 TXT/JSON 元信息 |
| 视频 | 普通清晰度与声明的原视频候选，原生保存对话框、进度、取消、备用地址及真实媒体轨道检查 |
| 实况素材下载 | 原图与配对 MP4，单项/选中项保存；缺失配对视频时不报告完整保存 |
| ZIP 导出 | 所选原图、单独实况或混合普通图 + 实况 MP4，自动附带笔记文案，进度和取消；桌面总输入上限 256 MiB，超出可分批或保存目录 |
| 主页批量 | 独立的小红书网页登录/验证、可清除会话、请求间隔和随机延迟、持久队列、分页与失败筛选、倒计时、暂停/继续/停止/失败重试 |
| 主页文件归档 | 首次发现序号及标题命名目录，保存原图/视频/实况/文案/元信息；完成文件按大小及 SHA-256 验证后跳过 |
| 本地实况制作 | 1–12 张图片或一个视频、图片排序/移除、逐张裁切/旋转/翻转/色调调整及统一应用、静态/推拉、0.5–8 秒、视频起点、封面、1/1.5/2/3 倍速、1 倍速保留声音、进度及取消 |
| 实况导出 | 配对 JPEG 或 HEIC + MOV，散件、配对 ZIP、含 `.pvt` 的 ZIP；写入相同配对 UUID 和封面时间轨道 |

实况照片保留封面所在图片的原始或裁切后像素，默认不再缩到 1440 像素。每张图片可自由框选、选择常用比例或输入原图像素裁切，调整只记录设置，生成时从原文件绘制，不反复压缩。固定比例可统一应用到不同尺寸图片；自由裁切统一应用时复制相同百分比区域。原文件保留。超出 150 MB 或合计 6400 万像素的导入仍需明确选择压缩副本，副本长边最高 4096 像素，并按图片张数分配像素预算；也可取消后分批导入。

动态 MOV 优先使用原始尺寸和随像素数增加的高画质码率，设备编码器不支持时选用较小的可编码画面，并让大图备用画幅按 16 像素对齐，避免硬件编码器额外平滑。结果会分别显示照片和动态尺寸。多图动态画幅以首图调整后尺寸为准，其它图片等比完整适配；静态封面使用所选图片自身的裁切尺寸。JPEG 使用最高质量参数，HEIC 使用质量 100 的本地编码器；HEIC 的色度转换仍属于有损编码。HEIC 本地上限为长边 8192 像素、6400 万像素，实际可用范围也受设备内存限制。

原视频表示笔记数据中声明的原始候选，并不凭地址承诺其一定无水印。音轨和媒体完整性会在实际下载后检查。主页任务每发现一批就保存这一批，再继续翻页；遇到登录验证或频率限制时暂停，用户在小红书窗口完成验证后继续。列表滚动会识别嵌套容器，短暂停滞时重新触发底部加载；已发出但尚未收到响应头、正文仍在读取和页面仍在加载都不计为停滞，持续 45 秒未完成则保留记录并暂停。只有当前有效的结束证据且没有在途分页请求，才确认主页末尾。未确认时始终显示发现数仍可能增加，保留具体停止原因，不把局部列表或当前批次全部保存标为整个主页完成。

主页批量调度是 Brclio 的适配与修复，不声称和参考程序逐字一致。参考程序等全部发现后才开始下载，缺少结束标记会让整批笔记一直等待；0.2.6 则在发现停滞后先保存已有队列。详细差异、可复现问题和真实主页测试限制见 [主页发现调查](xhs-profile-investigation.md)。

主页保存目录选定后会清除旧的缺少目录提示；后台旧队列状态不会覆盖新选择。运行中的队列不可更换目录。暂停时可为新任务选择其它目录，继续或重试原队列仍使用原目录，界面会恢复显示该队列的实际目录。

从 0.2.3 起，视频预览提前保留稳定高度，加载与播放不改变布局。视频、原图、整篇笔记、ZIP、实况素材及本地文件导出共用可见进度面板；已知总大小的单文件按字节显示百分比，多文件和未知大小显示持续进度、文件计数与已接收字节。完成校验及保存后才显示完成；浏览器或桌面交给系统下载的本地文件明确显示交接状态。

小红书网络与内置更新代理隔离：桌面 `persist:brclio-xhs` 会话固定为直连，Android 的小红书原生连接显式使用 `Proxy.NO_PROXY`。更新代理的开关与节点不会改变小红书下载线路。

主页批量与小红书网页登录为桌面功能。Android 保留源客户端的 Python 在线备用解析：仅用户选择时向固定官方公开解析接口发送笔记链接，不发送 Brclio Cookie 或 Authorization，也不使用源会员系统。Android 提供单篇原图/视频/原视频/文案/ZIP、原图复制与系统分享，系统分享来的笔记文案会填入单篇页，等用户点击解析。浏览器仅提供本地实况制作预览，不伪造本机下载能力。

`.pvt` 包在 Mac 解压后，可将整个包隔空投送给 iPhone/iPad。能否在目标设备「照片」中显示 LIVE 标识仍须在接收设备确认；本地校验覆盖文件格式、配对标识、时间轨道和媒体可解码性。

## 账号与本机数据

- Brclio 原有注册、密码/Google 登录、会话和偏好同步仍由 `desktop/account.cjs`、`web/account.js` 与现有服务处理。
- 小红书网站会话使用 Electron 分区 `persist:brclio-xhs`。这是用于读取笔记的网站授权，和 Brclio 账号分离；清除时保留下载文件与任务记录。
- 主页任务与原图剪贴板缓存位于 Brclio `userData/xhs/` 下。不会读取源下载器的旧账号或 Cookie。
- 会员、授权票据、激活码、支付订单、收银台与支付回调没有迁入。不需要源项目会员账号即可调用本地小红书功能。
- 本次没有新增云存储或服务，也没有迁移用户资料、头像与服务端凭据；官网沿用原 Worker，仅同步功能介绍。

## 桌面实现

`desktop/main.cjs` 延迟加载 `desktop/xhs/index.mjs`；只有受信任的 Brclio 主窗口可以通过 `brclio:xhs:request` 发起操作。`desktop/preload.cjs` 仅暴露限定入口 `xhsRequest` 和可取消订阅的状态事件。

下载逻辑按上述源提交直接移植：`lib/xhs.js` 整文件相同，Python 的解析与逐跳请求函数保持原文；原图 HTTP handler、ZIP、媒体轨道与图片尺寸模块也保留原文件。`lib/source-download.js` 从原 `app.js` 提取原文函数，执行原图代理及 HTTP 413 直连回退、视频 meta/chunk 分段、全部备用地址分段失败后再逐个直连，以及共用的 256 MiB 桌面归档预算。Brclio 只把原 HTTP 入口接入本地 handler，并传入取消和进度事件；媒体落盘后仍校验格式与音轨。原生单视频和原图剪贴板使用源 `net.request` 适配函数，页面与主页解析使用 Node 请求，避免 Electron `session.fetch` 拒绝手动重定向。

`npm run test:xhs-source-parity` 在源仓库可用时逐字核对整模块、提取函数与预算常量，并列出需要本地主机或账号适配的文件。它不是把所有适配模块都声明为整文件相同，也不要求 CI 存在原项目目录。界面、保存对话框及 Brclio 账号沿用本项目；源会员与支付接口不迁入。

图片与视频通过 `brclio-xhs://local/api/…` 本地协议读取，保留小红书 CDN 域名、HTTPS、每次重定向、类型和 Range 校验。保存目录必须由系统对话框授权；原生视频使用暂存目录，完整校验后发布目标文件。退出应用时暂停主页任务并等待下载清理。

实况纯计算模块在 `web/xhs/lib/`，HEIC 使用本地 Worker/WASM，素材留在本机。`web/xhs/assets/vendor/heic/` 含对应许可证、来源和可重建源码。CSP 只新增本地媒体协议、Blob/Worker 和 WASM 所需权限，未开启 Node renderer 或通用 `unsafe-eval`。

## Android 实现

`AndroidXhs.kt`、`XhsTransfer.java` 和 `XhsPolicy.java` 处理本地网络、下载、原图复制/分享和 SAF 文件保存。页面请求经过官方域名及每次重定向检查，再交给与桌面共用的纯 JS 解析器；不调用源项目的会员或支付接口。Python 在线备用固定使用 `https://xhs.download.brclio.com/api/python_parse`，拒绝重定向并验证响应媒体域名；若公开接口只报告原视频计数，本地补取可用地址和被过滤的实况配对，失败时保留计数并提示地址暂未取得。解析器由 npm 和 Gradle 从 `desktop/xhs/lib/xhs.js` 同步，避免两个平台各自维护一份规则。

媒体预览只通过受控的同源 `/xhs-media` 路径；其余远程子资源继续受原有 WebView 限制。保存通过系统文件选择器选择位置，多素材打包 ZIP。单个视频流式保存沿用源客户端的无总大小/总时长限制，仍保留连接及读取空闲超时、逐跳检查和媒体验证。

本地实况素材通过系统文件选择器导入。生成的 TXT、照片、MOV 或 ZIP 分块传给原生缓存，再由系统文件选择器导出，单份生成文件限 64 MiB。生成与有声编码能力取决于设备 WebView；界面会先检测能力。原图分享只为所选缓存文件提供临时只读 URI 授权，不扩大到更新文件或其它应用数据。

## 运行与打包

开发环境默认 Node 引擎可直接使用；备用 Python 可使用本机 Python。面向桌面用户的安装包必须内置目标系统/架构的独立 Python，无需用户安装 Python。

```sh
npm run prepare:xhs
npm start
```

`prepare:xhs` 在当前平台生成 `runtime/<mac|win|linux>-<arm64|x64>/python/`，固定 PyInstaller/certifi 版本，执行健康检查并写入源码指纹。此目录被 Git 忽略。应分别在对应平台与架构构建；不能将 macOS arm64 后台放进 Windows 或 Intel 安装包。

macOS 构建与 `--copy-from` 导入保留 PyInstaller framework 的相对符号链接，并检查链接未越界、悬空或循环。版本化 Python.framework 已被展开为普通文件的旧副本须重新构建；单独通过 Python 健康检查不足以证明框架可签名。

```sh
python3 scripts/prepare-xhs-runtime.py --check
npm run build:mac
# Windows 原生构建：npm run prepare:xhs && npm run build:win
```

`beforePack` 拒绝缺失、平台/架构不匹配或与 Python 源码指纹不同的后台。`extraResources` 将后台放入安装包 `resources/xhs-python`。Release 和 Windows 安装验证工作流已加入构建后台步骤。

## 验证

```sh
npm test
npm run test:xhs
npm run test:xhs-ui
npm run test:xhs-profile-ui
npm run test:xhs-profile-discovery
npm run test:xhs-desktop
npm run test:xhs-live
npm run test:xhs-live-import
npm run test:xhs-live-editor
npm run test:xhs-live-quality
npm run test:xhs-android-bridge
```

桌面验证脚本使用独立临时用户目录和本地 HTTPS 替身，覆盖真实 Electron main/preload、IPC、协议、目录选择、解析、原视频实际保存及原账号入口。不会登录或改写真实小红书/Brclio 账号。

Android 单元测试与 lint 可用已有 [Android 构建步骤](android.md#构建)运行；`XhsPolicyTest`、`XhsArchivePolicyTest` 覆盖链接与媒体策略。调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`，其包名与正式安装隔离，不代表正式安装包已经发布。

在独立的调试模拟器安装该 APK 后，可设置 `BRCLIO_ADB`（或 `ANDROID_HOME`）和 `BRCLIO_ANDROID_DEVICE` 运行 `npm run test:xhs-android`。脚本验证系统分享入口、本机图片选择、真实 WebView 编码、分块传输、SAF 导出/取消及本地原视频解析；不连接真实账号或小红书服务。使用独立测试设备，报告位于 `artifacts/xhs-android-verification.json`。

实况端到端测试还需 `ffmpeg`、`ffprobe` 和 Python；macOS 可额外使用系统 ImageIO 验证 HEIC 像素和 MakerApple 配对标识。测试在生产 `file://` 主窗口与 CSP 下操作真实 UI，并读回导出的 MOV、照片和 ZIP。验证报告与截图保存在被忽略的 `artifacts/xhs-*.json`、`artifacts/xhs-*.png`。

编辑器回归覆盖单图与统一裁切、不同原始尺寸、重排、取消、迟到回调和 320px 布局，报告位于 `artifacts/xhs-live-editor/`。清晰度回归使用真实 4K 高频图案和视频，比对导出尺寸、配对标识及亮度 SSIM，同时验证 6000 × 4000 照片保留原像素，报告和样例位于 `artifacts/xhs-live-quality/`。

真实小红书线上可用性仍受笔记公开状态、网站策略、Cookie/验证码及媒体 URL 有效期影响；离线替身测试不声称覆盖这些外部状态。

软件账号、会员、支付、旧更新器和反馈系统不迁入；工具箱沿用 Brclio 原实现。源客户端的课程、私教、VIP 群与站点福利等营销外链不属于本机小红书媒体处理模块。
