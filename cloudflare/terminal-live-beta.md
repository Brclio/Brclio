# 桌面终端只读实时观看测试

仅在开启观看测试的客户端显示可用状态。两名已登录的用户须属于同一共享主机库。所有者先选择活动窗格和一名已接受邀请的成员，将一次性邀请码交给该成员。对方输入邀请码并同意后开始观看。更换窗格、断开连接、锁屏或任一方结束会话即停止。终端回显的命令和可见输出会显示给成员。

## 服务与额度

独立的 `wrangler.terminal-live-beta.toml` 使用 Cloudflare Workers Free 可用的 SQLite Durable Object。配置默认没有公网路由。每个主机库同时最多开一个会话，仅允许一名所有者和一名具名观看者。DO 在内存中保存会话元数据和待转发的一帧，关闭后清除。服务禁用了观测日志，屏幕文字不写入 GitHub 或 Durable Object 存储。

每场最多三分钟。桌面端仅在可见文本变化时发送，每 2.5 秒最多一帧，单帧上限为 8,192 个 UTF-16 代码单元。服务端每两秒最多转发一帧，每场至多 90 帧。建立连接时分别核对两个账号。服务端仅在双方租约均有效时转发。双端首次各调用账号服务的 session 和 open 验证身份和共享库权限。租约最长 15 秒，过期后暂停转发，新的画面变化才触发一次双方续期，每方分别以当前登录令牌调用 open 核验。每场最多 12 轮续期，即最多 24 次额外 open 检查，静止画面不触发刷新。任一方拒绝、登录失效或双方未在 12 秒内恢复授权即结束。撤回观看会即时关闭连接。其他设备上移除成员或注销会话后，停止转发的最长授权缓存为 15 秒。读取权限失败也会停止转发。免费额度由同一 Cloudflare 账号上的服务共同使用。[Workers Durable Objects 免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## 本地验证

从仓库根目录安装客户端和 Cloudflare 各自的锁定依赖后执行：

```sh
node --test cloudflare/test/terminal-live.test.js
node scripts/verify-terminal-live-view.cjs
```

图形验证使用两个独立桌面客户端、两个临时签名账号和本地 workerd，检查双人同意、前序历史、隐藏文字、控制序列、只读性和终止。它仅连接回环地址。测试依赖可通过 `npm ci` 和 `npm --prefix cloudflare ci` 安装。

以公开测试环境运行还需要项目方在既有受信账号域名上将 `/api/account/apps/terminal/live-view` 和 `/terminal-live-socket/*` 两条路径指向独立测试 Worker，通过只读调用既有账号服务的 Service Binding（`BRCLIO_ACCOUNTS`）验证身份，并配置 Free Durable Object 绑定。桌面端通过 `BRCLIO_TERMINAL_LIVE_BETA=1` 启用。该配置和测试命令不部署，也不自动创建公网路由。直播 Worker 不需要 GitHub 凭据或账号签名密钥，二者始终留在既有账号服务。真实账号的认证令牌只用于既有 Brclio 账号域名，观看成员拿到的一次性 WebSocket 票据仅限本场会话。

观看者每场最多可提交六份单行草稿，至少间隔五秒，与屏幕共享使用相同的授权期限。主持人可忽略、编辑或手动填入所选窗格，再由主持人按 Enter。草稿只在会话内短暂传输。
