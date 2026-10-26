# dsh-plugins

DeepSeek Harness（DSH）插件集合。每个子目录是一个独立插件，可单独安装。

| 插件 | 一句话说明 |
|---|---|
| [`dsh-chat-rewrite`](dsh-chat-rewrite/) | 直接改写 DSH 会话日志：从某一轮起删掉它之后的所有对话（可选只删回答、保留该轮提问）；打开着的会话也能当场生效 |
| [`dsh-web-fetch-family`](dsh-web-fetch-family/) | 按域名族钉死 `web_fetch` 的连接地址族（IPv4-only / IPv6-only），规则存在独立 JSON 文档里，在插件管理页编辑 |

## 安装

**统一走 DSH 官方的插件管理通道**，仓库里不附带手工安装脚本：

1. 打开插件管理页（或调用 `plugin_manager` 工具）
2. 把插件目录作为本地包安装：`link:<插件目录绝对路径>`（例如 `link:E:/path/to/dsh-plugins/dsh-chat-rewrite`）
3. 重启桌面版

官方通道会自行维护 profile 的 `dependencies`、`dsh.profile.bundles` 与 `node_modules` 联接，
`cordis.patch.yml` 里的 Loader 行随之生效。手工改 profile 文件会让这份记录和插件管理器的账本不一致。

各插件的安装前提与依赖写在它自己的 README 里。
