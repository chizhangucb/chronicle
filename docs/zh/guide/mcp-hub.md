# MCP Hub

一个真正在 Chronicle 内部运行的聚合式 MCP 服务器：把任何 AI 工具指向单一端点，你在各个工具中配置过的每一个 MCP 服务都会通过它呈现出来，并带有按工具的策略、项目作用域和内置检查器。

大多数开发者都积攒了同一批 MCP 服务器，被复制粘贴到四个不同的配置文件里——`~/.claude.json`、`~/.cursor/mcp.json`、`~/.gemini/settings.json`、`~/.codex/config.toml`——每一份都在逐渐失去同步。MCP Hub 用单一的控制平面取代了这种散乱。Chronicle 暴露一个 Streamable-HTTP 端点，代你连接到所有上游服务，并以稳定的命名空间名称重新发布它们的工具。配置一次，即可集中启用/禁用和设定作用域，你指向 hub 的每个工具都会看到同一套受治理的工具集。它遵循与 [Skills Hub](./skills-hub.md) 相同的 **Takeover → Centralize → Distribute**（接管 → 集中 → 分发）模式。

> **本地优先：** hub 会连接到你配置的任何上游服务器（其中一些可能是远程的），但 hub 本身运行在你的机器上、绑定到 localhost，并校验请求来源。Chronicle 绝不会为了中转你的 MCP 流量而回传数据。

## 端点

hub 是一个可用的 MCP 服务器，位于：

```
http://localhost:4173/mcp     # npm run dev
http://localhost:41730/mcp    # npm run desktop / npm run standalone
```

它针对 **2025-03-26** 版 MCP 规范使用 **Streamable HTTP**（`server/mcp/hub.js`）：

- **POST** 承载 JSON-RPC。`initialize`、`tools/list`、`tools/call`、`ping` 和 `notifications/*` 均被处理；JSON-RPC 批量请求被拒绝。
- 在 `initialize` 时，hub 铸造一个会话，并在 **`MCP-Session-Id`** 响应头中返回它；客户端在后续请求中回传该值。`serverInfo` 报告为 `chronicle-mcp-hub`。
- **来源校验（Origin validation）** 会拒绝任何不是 `localhost`/`127.0.0.1` 的浏览器 `Origin`（CSRF 防护）。非浏览器客户端（不发送 `Origin`）则直接放行。
- **DELETE** 结束一个会话；**GET** 返回 `405`——hub 不提供服务器推送的 SSE 流，因此客户端只需回退到仅 POST 模式。

将任何支持 MCP 的工具指向那个 URL。在工具自身的 MCP 配置中，添加一个 `url` 为 hub 端点的 HTTP 服务器条目：

```jsonc
{
  "mcpServers": {
    "chronicle": { "type": "http", "url": "http://localhost:4173/mcp" }
  }
}
```

### 命名空间工具

每个上游工具都以 **`service__tool`**（双下划线分隔符）的形式重新发布。一个 `filesystem` 服务器的 `read_file` 工具会变成 `filesystem__read_file`，并且每个工具的描述都会以 `[service]` 作为前缀，这样模型就能一目了然地知道其来源。当客户端用一个带命名空间的名称调用 `tools/call` 时，hub 会拆分它、找到所属的服务，并把请求路由到正确的上游——可能是 **stdio 子进程**和**远程 HTTP 服务器**的混合，取决于你如何配置。

**MCP Hub** 页面头部会显示实时状态：端点、已启用的服务数、已连接的客户端会话数，以及每个已连接 stdio 子进程的一个绿色标签（其 PID 和工具数量）。

## 配置接管

打开 **MCP Hub → Config takeover** 以导入你已经配置好的内容。Chronicle 会扫描（`server/mcp/registry.js` 中的 `scanMcpConfigs()`）：

| 来源 | 文件 |
| --- | --- |
| Claude Code（用户级） | `~/.claude.json` |
| Claude Code（项目级） | 每个导入项目中的 `.mcp.json` |
| Cursor | `~/.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml`（TOML `[mcp_servers.*]` 小节） |

每个发现的服务器都会被分类（`classifyScan()`），因此你能确切知道一次导入会做什么：

- **New** — 尚未在 hub 中。
- **Updated** — 已从同一来源导入过，但其 command/args/env/url/headers 发生了变化。
- **Conflict** — 存在一个同名服务，但它来自*另一个*工具的配置（两处定义不一致）。
- **Unchanged** — 与已注册的内容完全相同；跳过。

点击 **Import**，Chronicle 会在写入任何内容**之前**把每个源文件备份到 `~/.chronicle/backups/mcp/<timestamp>/`（保留最近五套），然后注册 New/Updated/Conflict 条目。你的原始配置文件**永远不会被改写**——接管是单向地复制*进* Chronicle，因此日后移除 hub 会让你的工具原封不动地保持原样。

## 管理服务

**Services** 选项卡列出每一个已注册的上游，以及它的传输方式（`stdio` / `http` / `sse`）、它的来源配置，以及它的命令或 URL。

- **按服务启用 / 禁用**——被禁用的服务会从 `tools/list` 中隐藏，并拒绝 `tools/call`。
- **Remove from hub** 只会删除注册表条目；它来自的源配置不受触动。
- **密钥会被遮蔽。** 任何键名看起来像凭证（`token`、`key`、`secret`、`pass`、`auth`）或值很长的环境变量，以及每一个请求头的值，都会在所有 API 输出中被遮蔽（`maskService()`）。Chronicle 在本地存储真实值以进行上游调用，但绝不会把它们原样返回给 UI。

### 工具策略

启用整个服务器往往过于粗放——你想要它的读取工具，却不想要它的写入工具。在某个服务上点击 **⛭ policy** 以打开它的工具面板：取消勾选任何工具，它就会既被**从 `tools/list` 中隐藏**，又在 `tools/call` 时被**阻止**。被阻止的调用会被记录到检查器日志中，而不是被悄无声息地丢弃，因此你能看到客户端试图触及什么。策略是按服务存储的（`setDisabledTools()`），因此同一套受治理的接口会应用于通过 hub 连接的每一个工具。

### 项目作用域（MCP Roots）

一个服务可以被**限定到某个项目路径**，使它只对在该项目内工作的客户端可见。当客户端连接时，hub 会读取它的**根（root）**——来自显式的 `x-chronicle-root` 头，或它 `initialize` 参数中的 `rootUri` / `workspaceFolders`——并按**最长前缀匹配**路由 `tools/list`（`servicesForRoot()`）：

- 根位于某个受限定项目内的客户端，会看到**匹配得最深的**受限定服务，外加所有未限定的（全局）服务。
- 没有根、或根落在所有作用域之外的客户端，只会看到全局服务。

这样就能把某个项目专属的数据库或部署服务器挡在无关的会话之外，而无需为每个仓库维护单独的配置文件。

### 按服务的凭证

对于远程 HTTP 服务，可以为某个服务附加一个 **bearer token**（`setCredential()`）；hub 会在上游调用中把它作为 `Authorization: Bearer …` 头应用，并在 UI 中处处遮蔽它。该令牌与服务定义一起存储在本地。

## 检查器

**Inspector** 选项卡是一个内置的 MCP 客户端，用于在不离开 Chronicle 的情况下调试 hub：

- **手动工具调用**——从实时列表中挑选任意带命名空间的工具，提供 JSON 参数并调用它。结果会内联渲染。如果某个上游服务连接失败，它的错误会在此处按服务显示。
- **JSON-RPC 日志**——一个滚动的环形缓冲区，记录经过 `/mcp` 的最近若干请求和响应（收到的、发出的、被策略阻止的、通知），最新的在前。这里正是被阻止的 `tools/call` 和任何路由错误浮现的地方。

用它来确认一次接管是否成功、验证某个工具策略是否在正确过滤，或复现一个已连接的 AI 工具所看到的内容。

## 整套模式，端到端

1. **Takeover（接管）**——导入散落在你各个工具配置里的 MCP 服务器，并自动备份。
2. **Centralize（集中）**——在一处启用/禁用、限定到项目、设置工具策略并附加凭证。
3. **Distribute（分发）**——把 Claude Code、Cursor、Gemini 或任何 MCP 客户端指向 `http://localhost:4173/mcp`。它们全都共享同一套受治理的、带命名空间的工具集，而一次策略变更会一次性在所有地方生效。

有关线级细节——上游连接如何被池化、`tools/list` 聚合和错误处理如何工作——请参见下面的架构说明。

## 相关内容

- [Skills Hub](./skills-hub.md) — 应用于 agent skills 的同一套 Takeover → Centralize → Distribute 模式。
- [安全与分享](./security-and-sharing.md) — 脱敏、pre-tool-use 守卫，以及会话的安全分享链接。
- [MCP 与 Skills 内幕](../architecture/mcp-and-skills-internals.md) — 注册表、上游连接层，以及 Streamable-HTTP 实现。
- [API 参考](../architecture/api-reference.md) — `/mcp` 端点规范和 `/api/mcp/*` 管理路由（两者彼此不同）。
