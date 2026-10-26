# dsh-web-fetch-family

按**域名族**钉死 `web_fetch` 的连接地址族：列进 `ipv4Only` 的主机只走 IPv4，列进 `ipv6Only` 的只走 IPv6。
规则在**插件管理页**里本 bundle 自己的配置页中编辑（不是 DSH 设置项）。

## 它怎么工作

undici（DSH 的 fetch 底层）在 `tls.connect({ host })` / `net.connect({ host })` 时读取
`options.lookup`，所以只要给这次连接注入一个固定地址族的 `lookup`，就能决定它走哪个协议栈。
两种作用域：

| mode | 行为 |
|---|---|
| `targeted`（默认） | 只接管"已经自己解析过主机名、并把 `lookup` 传下来"的调用方——正是 `dsh-web-fetch-enhanced` 的路径，进程里其它连接不受影响 |
| `global` | 任何主机命中规则的连接都改写，不管调用方是否自己解析过 |

## 唯一的存储

```
$DSH_HOME/web-fetch-family/config.json
```

```json
{ "version": 2, "mode": "targeted", "ipv4Only": ["example.com"], "ipv6Only": [] }
```

本包**不导出 Cordis `Config`**：那会让设置服务把易变字段写回 profile 的 `cordis.patch.yml`，
同一份规则就有了两个存放处。文档是唯一存储，页面是唯一编辑器。

## Host 路由（前缀 `/web-fetch-family/api`）

| 路由 | 说明 |
|---|---|
| `GET  /config` | 读当前规则文档 |
| `GET  /status` | 规则是否真的在链路上（`dsh-web-fetch-enhanced` 是否在场、当前 mode） |
| `POST /diagnose` | 对指定主机做一次地址族探测 |
| `POST /config` | 写入规则文档 |

## 依赖与约束

- 需要 `dsh-web-fetch-enhanced` 在链路上，规则才有落点；`/status` 会告诉你它在不在。
- 不使用任何 `@deepseek-ai/*` 导入：本包以 `link:` 方式安装，真实路径在 profile 之外，裸导入解析不到，
  所以只用 Node 内置模块。
- 浏览器半注册在插件管理器的 `plugins.bundle.config` 槽位，**键必须是 npm 包名**（`dsh-web-fetch-family`），
  写成 Loader row id 会静默不渲染。

## 安装

用 DSH 的插件管理通道把本目录作为本地包安装（`link:<此目录>`），装完重启桌面版。
