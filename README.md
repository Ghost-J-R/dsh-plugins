# dsh-plugins

DeepSeek Harness（DSH）插件集合。每个子目录是一个独立插件，可单独安装。

| 插件 | 一句话说明 |
|---|---|
| [`dsh-chat-rewrite`](dsh-chat-rewrite/) | 直接改写 DSH 会话日志：删除任意一轮对话、删除某条回答、改写中间轮次；打开着的会话也能当场生效 |

## 安装

每个插件目录里有自己的 README 和 `install.mjs`，按其中说明安装。
通用做法（以 `dsh-chat-rewrite` 为例）：

```powershell
node dsh-chat-rewrite/install.mjs --profile-dir "$env:USERPROFILE\.dsh\profiles\desktop"
```

或走 DSH 官方的插件管理通道把该目录作为本地包安装。
