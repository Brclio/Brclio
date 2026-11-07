# Brclio 下载器官方下载入口

独立 Worker `brclio-downloader-site` 使用 `https://tools.brclio.com/downloader/`。便捷版三个下载按钮均使用本站路径。Worker 从 `Brclio/Brclio` 的 `lite-stable/latest.json` 读取最新版本与 SHA-256，将对应版本的 Lite 安装包按大小和完整 SHA-256 校验后返回。针对同一文件摘要的边缘缓存命中后直接传输缓存正文。完整版按钮通过 `downloader-stable/latest.json` 找到官方 GitHub 安装包并重定向。

发布索引刷新间隔为 60 秒。便捷版单文件上限为 16 MiB。增大上限前应复核 Workers 内存预算或采用对象存储。服务器不接收用户提供的上游地址，GitHub 签名跳转仅允许官方 Release CDN。浏览器仅在本地识别硬件，无需上报识别结果。Safari 无法准确区分 Mac 芯片时由用户选择。

从仓库根目录验证与部署：

```sh
node --test downloader-site/worker.test.mjs
npm ci --prefix cloudflare
(cd downloader-site && ../cloudflare/node_modules/.bin/wrangler deploy --dry-run)
(cd downloader-site && ../cloudflare/node_modules/.bin/wrangler deploy)
```

部署账户与域名归属记录在本目录的 Wrangler 配置中。只注册 `tools.brclio.com/downloader/*` 路由。发布后核对主页、三个便捷版文件的 SHA-256、三个完整版重定向以及原有 `/api/health` 和 `/api/releases/latest`。

执行 `node downloader-site/verify.mjs` 可从公开地址逐个下载便捷版、与 GitHub 最新索引逐字节核对大小和 SHA-256，并检查完整版链接及原有客户端服务。
