# 软件图标

图标来自用户指定的 [Brclio 组织标志](https://github.com/Brclio/brand-studio/blob/main/data/Brclio%20%E7%BB%84%E7%BB%87%E5%A4%B4%E5%83%8F/brclio-logo.svg)，保留完整画布、配色和比例。

原始 SVG 的 SHA-256：`9b5252a462895b87f45470f62b1ae01cdef5fb3080a30415f2fa7f45dddaff91`。
SVG 约 38.7 MiB，仅作为生成输入；客户端使用本地 PNG、ICO 和 ICNS，无须联网加载品牌图标。

下载上述原始文件后，在 macOS 上重新生成：

```sh
node scripts/generate-icons.mjs /path/to/brclio-logo.svg
```

需要项目现有 npm 依赖、Chrome 和系统 `iconutil`；可用 `BRCLIO_CHROME` 指定 Chromium 路径。

- `icon.png`：1024×1024，供开发时的 macOS Dock 使用。
- `icon.icns`：macOS 打包图标，包含 16–1024 像素表示。
- `icon.ico`：Windows 打包图标，包含 16、24、32、48、64、128、256 像素表示。
- `../web/assets/icon.png`：256×256，供网页标签页、侧栏和 Electron 窗口使用。
- `../android/app/src/main/res/mipmap-*/ic_brclio.png`：Android 各密度图标。
- `../android/app/src/main/res/drawable-nodpi/ic_brclio_foreground.png`：Android 自适应图标前景，保留系统圆形、圆角方形等遮罩所需的安全留白。

设计素材及衍生设计沿用项目的 CC BY-NC-SA 4.0 署名约定。
