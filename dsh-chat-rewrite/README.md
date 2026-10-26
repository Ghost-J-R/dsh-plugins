# dsh-chat-rewrite

真改写 DSH 会话的第三方面板：**在磁盘上**删掉最后一轮、或重答某一轮。
不是界面隐藏——它直接重写 `$DSH_HOME/sessions/<项目>/<会话>/session.v4.jsonl.zstd`。

## 它做什么

每条**已定稿的 AI 回答**的操作行里多一个**红色垃圾桶**按钮（排在复制/点赞之后、分支之前——
这一行由 DSH 的 `conversation.chat.assistant-actions` 插槽渲染，插槽的契约就是"插在复制与分支之间"）。

点它 → 自动定位这条回答属于哪一轮 → 二次确认 → 真改写：

| 操作 | 效果 |
|---|---|
| **删除这条回答及其之后** | 保留这一轮的提问，删掉它之后的所有回答、思维链、工具调用（会话变成"刚问完还没答"的状态，可以重新发问） |
| **回到这一轮之前**（面板里） | 连这一轮的提问一起删掉，回到上一轮结束 |
| **还原**（面板里） | 从手动备份写回原件 |

第一轮不可"回到之前"（没有更早的历史）。

**打开的会话也能当场删**：DSH 的 Session controller 会把 `AgentHandle`（唯一能释放会话的能力）丢掉，
所以没有任何受支持的 API 能释放一个正在被 Host 持有的会话。插件在 Host 进程内包装
`AgentRegistry.resume`，把每个 handle 记下来，需要时：

```
dispose(handle)  → 会话被释放（写句柄关闭、租约释放）
                 → 帧边界截断日志
                 → 客户端 session.resync() 重新读盘
                 → 界面立刻显示截断后的历史
```

* 正在生成（`agent.status === 'running'`）时拒绝删除，避免砍掉进行中的 turn。
* 如果某次升级让 `AgentRegistry.resume` 的形状变了，这条路径失效 → 自动退回「排队到下次启动」，
  **不会破坏数据**。
* handle 只在插件加载**之后**恢复的会话上才会被接管：安装后重启一次桌面版即可全覆盖。

## 为什么这样改是安全的

DSH 的会话日志是**多个独立 Zstandard 帧的首尾拼接**，而每次追加恰好写一帧、一帧对应一段连续事件。
所以**帧边界就是事件边界**，从末尾截断时：

```
前缀帧      -> 原样复制字节（一个 bit 都不动）
跨界那一帧  -> 解压、只留前 N 行、重新压缩
之后的帧    -> 直接丢弃
```

于是 **seq 不需要重编号、8 类坐标不需要重映射、assistant 内嵌流不需要重建**——
未触及的历史逐字节不变，这是最强的"真改写"证据。

已在 DSH 0.2.1-rc.3 上实测：

* 截断后的日志被 Host 的**只读打开**接受（`/api/session.export` 返回 200）
* 被 **写打开** 接受并继续追加（打开会话即写入 `session/end-seed`）
* **投影缓存自愈**：日志变短后缓存水位失效，DSH 自己从头重折叠（轮次导轨 9→8、token 统计同步变小）
* 对照组（中间挖掉一个事件、seq 断裂）被 Host 拒绝——校验是真的

## 安全护栏

1. **被 Agent 持有的会话先释放再改写**（拿不到释放能力时退化为排队到下次启动）。
   打开的会话在进程生命周期内一直持有写句柄与内存副本；在它下面换文件会让内存游标与文件错位，
   下一次追加写出非单调 seq，会话就废了。释放路径见下文「占用与释放」。
2. **备份全手动**：改写不留备份，面板里点「备份当前状态」才产生，插件永不自动删除你的备份。
3. **写入量最小化**：截断到最后一个保留帧的末尾 + 只写新的尾巴，前缀一个字节都不复制。

   | 场景 | 实测（普通会话 1.29 MB / 349 帧） |
   |---|---|
   | 删最后一轮，切点落在帧边界 | **写入 0 字节**（纯 `ftruncate`） |
   | 删最后一轮，切点跨在一帧中间 | **写入 4.1 KB**（只重压那一帧） |
   | fork 删继承轮 | 追加 inherited 标记，写入量取决于该帧大小 |

   两种路径写完都立即回读校验；万一截断与写尾巴之间出问题，内存里那份完整字节会原子替换修复。
4. 写完**立即回读并重新校验**：首帧只有 header、记录不截断、seq 从 0 密集。
5. 拒绝路径穿越：会话 id 按 Host 的 `encodeSegment` 规则编码后才拼路径。

## 限制（V1）

* **只支持当前格式 v4**；历史 v3 会话需要先在 DSH 里打开一次让它升级到 v4。
* **只支持尾部截断**（正是 Google AI Studio 的语义：回退到某条 = 删除它之后的一切）。
  中间编辑（改第 5 轮、保留第 6~10 轮）需要重编号 + 坐标重映射 + 内嵌流重建，不在 V1。
* **只能改"没被本进程打开过"的会话**。想改刚看过的会话，重启桌面版即可。
* fork 出来的子会话是父会话前缀的快照副本，改写父会话**不会**同步子会话（这是正确语义）。

## 安装

```powershell
node install.mjs                 # 装进当前 profile（默认 desktop）
node install.mjs --uninstall     # 卸载
```

只改两处：profile 的 `package.json`（依赖 + `dsh.profile.bundles`）和
`node_modules/dsh-chat-rewrite` 目录联接。不改动任何 DSH 文件。装完**重启桌面版**。

## Host 路由

挂载在 web server 的 `/chat-rewrite/api` 前缀下：

| 路由 | 说明 |
|---|---|
| `GET  /rewrite-inspect?sessionId=` | 标题、事件数、轮数、是否被 Agent 占用、缓存视图标记、真人轮次锚点表 |
| `GET  /rewrite-resolve?sessionId=&messageId=` | 把一条 assistant 消息映射到它所属的真人轮次 |
| `GET  /rewrite-backups?sessionId=` | 该会话的备份列表（含每份字节数） |
| `GET  /rewrite-pending?sessionId=` | 该会话是否已排队 |
| `GET  /rewrite-health` | 自检：拦截是否装上、捕获了哪些会话、最近一次 resume / 释放结果 |
| `POST /rewrite-apply` | `{sessionId, promptSeq, mode:'before'\|'after', confirm:true}` |
| `POST /rewrite-queue` | `{sessionId, turn, mode}` —— 当场删不了时的排队兜底 |
| `POST /rewrite-restore` | `{sessionId, stamp, confirm:true}` |
| `POST /rewrite-backup-create` | `{sessionId}` —— 手动备份当前状态 |
| `POST /rewrite-backup-delete` | `{sessionId, stamp, confirm:true}` —— 删除单份备份 |
| `POST /rewrite-backup-purge` | `{sessionId, confirm:true}` —— 清空该会话全部备份 |

> 所有路由都带 `rewrite-` 前缀：这套 API 只属于本插件的改写子域，不使用 `health`、`apply`
> 这类看起来像公共接口的名字。

## 开发自测

七套自测，前六套自带沙箱（`.exp/sandbox-*` 的假 `$DSH_HOME`），**不会写入真实会话**；
`test-theme` 只读源码：

```powershell
node tools/test-host.mjs         # 宿主：inspect / apply / restore / 护栏 / header 帧逐字节复制
node tools/test-release.mjs      # 释放 live 会话 + 当场改写
node tools/test-cachedview.mjs   # 只有缓存视图（无 Agent）时直接改写
node tools/test-seeded.mjs       # fork 继承轮删除（重设切点）
node tools/test-backups.mjs      # 备份：手动创建 / 删除 / 清空，改写不留备份
node tools/test-queue.mjs        # 排队兜底 + 启动执行
node tools/test-theme.mjs        # 面板只用官方 token：无写死颜色、无自造 token
```

夹具不随仓库提交：`tools/fixture.mjs` 在运行时从本机 `$DSH_HOME/sessions`（或 `DSH_HOME_REAL`）
里挑一个能解码的会话，复制进沙箱再操作，所以这些测试在任何安装上都能跑。`test-seeded` 需要至少一个
fork 会话，没有就自跳过。
## 客户端：主题与样式

面板是 `shell.overlay` 槽位里的一个 occupant（`shell.overlay` 是官方的"框架级浮层"，
`workspace.session-rename`、`archive-manager.delete-session` 这些官方对话框也挂在同一个槽位；
这个 DSH 版本没有 dialog 服务或 dialog 槽位，所以对话框必须自己渲染）。

因此样式必须**只用官方主题 token**，否则暗色主题下会露白：

| 用途 | token |
|---|---|
| 对话框面板背景 | `--dsw-alias-bg-overlay` |
| 嵌套面/徽章背景 | `--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2` |
| 边框 | `--dsw-alias-border-l1`、`--dsw-alias-border-l2` |
| 文字 | `--dsw-alias-label-primary`、`--dsw-alias-label-secondary` |
| 主按钮/链接 | `--dsw-alias-brand-primary` |
| 成功/失败/警告 | `--dsw-alias-state-success-primary`、`-error-`、`-warn-` |

官方 token 只有 14 个，全部列在 `cordis_inspect_query(platform:"client", provider:"Theme", method:"listTokens")`。
`styles` 数组里的颜色**不允许**出现 `#fff` 之类的固定浅色；需要半透明底色时用
`color-mix(in srgb, var(--dsw-alias-*) N%, transparent)`，这样明暗两套主题都成立。
遮罩层的黑色 `rgba(0,0,0,.45)` 是例外：遮罩本身与主题无关。

样式表通过动态客户端内置的 `styles.insert(css)` 注册（随客户端 run 一起销毁），
只有该内置缺失时才退化为插入 `<style>` 元素。

