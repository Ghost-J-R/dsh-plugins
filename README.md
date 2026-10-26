# dsh-plugins

DeepSeek Harness（DSH）插件集合。每个子目录是一个独立插件，可单独安装。

| 插件 | 一句话说明 |
|---|---|
| [`dsh-chat-rewrite`](dsh-chat-rewrite/) | 直接改写 DSH 会话日志：删除任意一轮对话、删除某条回答、改写中间轮次；打开着的会话也能当场生效 |
| [`dsh-web-fetch-family`](dsh-web-fetch-family/) | 按域名族钉死 `web_fetch` 的连接地址族（IPv4-only / IPv6-only），规则存在独立 JSON 文档里，在插件管理页编辑 |

## 安装

每个插件目录里有自己的 README，按其中说明安装。两种方式：

- 有 `install.mjs` 的（如 `dsh-chat-rewrite`）：`node <插件>/install.mjs --profile-dir "%USERPROFILE%\.dsh\profiles\desktop"`
- 没有的（如 `dsh-web-fetch-family`）：走 DSH 官方的插件管理通道，把该目录作为本地包（`link:<目录>`）安装

装完重启桌面版。
