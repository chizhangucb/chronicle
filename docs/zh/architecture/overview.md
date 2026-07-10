# 架构总览

Chronicle 是一台面向 AI 编码会话的本地优先「时间机器」：它导入来自六款工具的对话日志，将每一条消息映射到那一时刻的 Git 快照，并叠加了 MCP Hub、Skills Hub、安全脱敏、实时流式传输与确定性回放——所有这些都运行在单个 Node 进程中，没有云端后端，也不做任何 LLM 调用。

本页是全局地图。它先阐明一切设计的根基——**单进程、单端口**——然后逐层介绍各个组件、三种运行模式，以及让代码库保持诚实的产品原则。请先读它；其余架构页面会深入到每一个方块的细节。

## 单进程、单端口

Chronicle 由三个 Express 应用和一个 React UI 组成。这三个应用是：

| 应用 | 挂载点 | 职责 |
| --- | --- | --- |
| `server/api.js` | `/api` | 全部 REST 路由（扫描/导入、项目、会话、git、搜索、安全、skills、MCP 管理、回放、反馈） |
| `server/shares.js` | `/share` | 由本地应用提供的、已脱敏的、带令牌的公开分享页面 |
| `server/mcp/hub.js` | `/mcp` | 聚合式 MCP 服务器（Streamable HTTP） |

关键手法是：**在每一种运行模式下，被服务的都是完全相同的这几个应用对象。** 在开发模式下，它们被挂载*进* Vite 开发服务器；在生产模式下，一个普通的 Express 服务器（`server/standalone.js`）直接挂载它们。往其中一个应用里添加一个端点，它就能在 dev、desktop 和 standalone 三种模式下免费生效——无需按模式分别接线。

在 dev 模式下，`vite.config.js` 安装了一个小插件（`chronicleApi`），把中间件挂到 Vite 的 connect 服务器上，并按请求惰性加载每个应用：

```js
// vite.config.js — one process, one port
server.middlewares.use('/api', async (req, res, next) => {
  const { api } = await server.ssrLoadModule('/server/api.js');
  api(req, res, next);
});
```

`ssrLoadModule` 这个调用是刻意为之的：它意味着 API 走的是 Vite 的 SSR 模块图，因此**编辑 `server/*.js` 会热重载 API**，而无需重启进程。你在同一个端口（`4173`）上同时获得 UI HMR 和 API 热重载。

生产环境中没有 Vite。`server/standalone.js` 构建一个 Express 应用，挂载相同的三个应用，并将构建产物 `dist/` 用于服务其余一切内容：

```js
// server/standalone.js
app.use('/api', api);
app.use('/share', sharePage);
app.use('/mcp', mcpEndpoint);
app.use(express.static(dist));
app.get(/^\/(?!api|share|mcp).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
```

> **陷阱——挂载的必须是 Express *应用*，而非 Router。** Vite 中间件交给应用的是原始的 Node `req`/`res`。Express 的 *Router* 不会装饰这些对象，因此 `res.json` 为 `undefined`，每条路由都会抛错。挂载一个完整的 Express *应用*（它会安装这些响应辅助方法）才能让同一份代码既跑在 Vite 之后、又跑在 `standalone.js` 之后。请把新端点加在应用上，而不是裸 Router 上。

## 组件地图

```
┌──────────────────────────────────────────────────────────────┐
│  Desktop shell — Electron (electron/main.mjs)                 │
│  tray, single-instance lock, auto-update; zero server imports │
└───────────────────────────┬──────────────────────────────────┘
                            │ starts
┌───────────────────────────▼──────────────────────────────────┐
│  Server layer (Node, node:sqlite, shells out to git)          │
│                                                               │
│  parsers/      claudeCode · codex · cursor · opencode ·       │
│                gemini · copilot   → normalized events         │
│  db.js         projects / sessions / messages  (SQLite)       │
│  git.js        read-only snapshot engine (rev-list/ls-tree)   │
│  live.js       JSONL tail + SQLite poll → SSE                 │
│  replay.js     deterministic sandbox re-execution             │
│  causality.js  read→change linking (heuristic)                │
│  security.js   redaction rules, pre-tool-use check            │
│  mcp/          registry + Streamable-HTTP hub                  │
│  skills.js     central store + symlink fanout                 │
│  shares.js     tokenized redacted /share pages                │
│                                                               │
│  Exposed as three Express apps → /api · /share · /mcp         │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼──────────────────────────────────┐
│  React UI (src/) — plain React + one styles.css, no framework │
│  App.jsx global sidebar · SessionView playback/refine/replay  │
│  hand-rolled SVG charts · i18n (en/zh/ja)                     │
└──────────────────────────────────────────────────────────────┘
```

这种分层在一个真正重要的方向上是严格的：**服务器层没有任何 Electron 导入。** Electron 启动服务器并掌管窗口/托盘，但 `server/` 之下的任何东西都不知道 Electron 存在。这让未来换成 Tauri 只是一次 shell 层面的变更，而非一次重写（见 [桌面端与打包](desktop-packaging.md)）。

## 运行模式

三种模式都服务相同的三个应用；它们的唯一区别在于外层包装了什么。

| 命令 | 运行的是什么 | 端口 | 备注 |
| --- | --- | --- | --- |
| `npm run dev` | Vite 开发服务器 + 通过插件挂载的应用 | `http://localhost:4173` | UI HMR **且** API 热重载（`ssrLoadModule`） |
| `npm run desktop` | `vite build` → Electron shell + 托盘 | `41730` | 生产构建，窗口隐藏至托盘 |
| `npm run standalone` | `server/standalone.js`，无界面 | `41730` | 绑定 `127.0.0.1`；`PORT` 可覆盖；UI + `/api` + `/share` + `/mcp` |

Electron 在内部运行 standalone 服务器，因此「desktop」和「standalone」是同一份服务器代码，区别仅在于有没有窗口。

### `globalThis` 上的状态

Vite 的 SSR 通过重新求值来重载一个模块。如果某个 watcher 或子进程存活在模块作用域的变量里，一次重载就会把它变成孤儿——旧计时器继续触发，新模块却看不见它。Chronicle 通过把长期存活的单例停放在 `globalThis` 上来规避这一点：

- `__chronicleLive` —— 实时 tail/poll 的 watcher（`server/live.js`）
- `__chronicleHub` —— MCP hub 的上游子进程与会话
- `__chronicleSkillWatch` —— skills 文件系统 watcher

因为 `globalThis` 能在模块重新求值后存活，一次热重载会重新绑定代码，却不会泄漏它所管理的资源。这就是为什么你能在会话进行中编辑 `server/live.js` 而不会堆积出一大堆 watcher。

## 产品原则（以及技术栈为何长这样）

六条原则贯穿每一个子系统。它们值得明确写出来，因为它们解释了那些若不解释就会显得保守的选择。

1. **本地优先、默认离线。** 解析、查看和管理一个会话都无需任何网络调用。仅有的、刻意为之的对外功能是更新检查、GitHub skill 导入和反馈中继——每一项都是可选加入且范围狭窄的。
2. **Git 是代码状态的唯一真相来源。** 快照是通过将提交历史与对话时间戳相匹配来重建的——绝不来自单独的快照存储，也绝不来自当前磁盘。见 [Git 快照引擎](git-snapshot-engine.md)。
3. **接管 → 集中 → 分发。** 这是 MCP Hub 与 Skills Hub 背后的共享控制平面模式：采纳分散的配置，将其集中于一处，再重新分发出去（命名空间化的工具、符号链接的 skills）。
4. **对外部系统只读。** 源日志和项目仓库永不被写入。SQLite 类源在打开前会被复制到临时目录（见 [解析器与摄取](parsers-and-ingestion.md)）；git 引擎只做读取。
5. **默认安全。** 回放在沙箱中运行，脱敏是单向的，破坏性操作会先备份并需要一次显式点击。
6. **一切重活都是启发式 + 本地的。** 因果关系置信度分级、脱敏正则、活跃时长计算——全都是本地启发式。**任何地方都没有 LLM 调用**，这正是离线保证得以成立的原因。

### 关键技术栈决策

- **`node:sqlite`（`DatabaseSync`），而非 better-sqlite3。** 零原生编译，因此应用无需在目标机上装编译器即可构建与分发。整个 schema 在模块作用域内幂等地创建；迁移就是一行行 `try { ALTER TABLE … } catch {}`。见 [数据模型](data-model.md)。
- **git 引擎通过 shell 调用 `git`**（`execFileSync`），而不是链接 libgit2——没有原生依赖，并且它使用的就是开发者本已信任的那个 `git`。
- **选 Electron 而非 Tauri**——开发机上没有 Rust 工具链，而「零 Electron 导入」的规则让 Tauri 这条路保持畅通，以备将来那约 100 MB 的框架底盘变得值得甩掉。
- **纯 React + 一个 `styles.css`**（CSS 变量、深色主题）——没有 UI 框架。**图表全靠手写 SVG/CSS**（折线趋势、锥形渐变环形图）——没有图表库。更少的依赖、更小的产物、完全的掌控。
- **依赖纪律：** 只有真正的服务器运行时依赖（`express`、`electron-updater`）位于 `dependencies`；客户端库（`react`、`react-dom`、`diff`）都是 `devDependencies`，因为 Vite 会把它们打包进 `dist/`，而 electron-builder 会把 `dependencies` 里的一切都装进应用。

## 相关

- [数据模型](data-model.md) —— SQLite schema 以及每个子系统读取的归一化事件模型。
- [解析器与摄取](parsers-and-ingestion.md) —— 六款工具如何变成归一化事件，以及如何添加第七款。
- [Git 快照引擎](git-snapshot-engine.md) —— 从历史重建代码状态。
- [配置](../reference/configuration.md) —— `~/.chronicle/` 目录布局、环境变量、`config.json`。
- [桌面端与打包](desktop-packaging.md) —— Electron shell、签名与自动更新。
