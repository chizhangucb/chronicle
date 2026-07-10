# MCP Hub 与 Skills Hub 内部机制

Chronicle 为那些被 AI 工具散落在你机器各处的东西——MCP 服务器配置与智能体 skills——提供了两个控制平面。两者都实现了同一个模式：**接管**那些散落的源，把它们**集中**到 `~/.chronicle`，再以命名空间化、非破坏性的方式把它们**分发**回去。

本页面向那些在 `server/mcp/registry.js`、`server/mcp/hub.js`、`server/mcp/upstream.js` 或 `server/skills.js` 上工作的贡献者。它解释聚合式 MCP 服务器如何为上游工具做命名空间化与路由、skills 存储如何通过符号链接扇出，以及——最重要的——那种让两个 hub 都能采纳真实用户配置却永不将其损坏的安全姿态。面向用户的演练，见 [MCP Hub](../guide/mcp-hub.md) 与 [Skills Hub](../guide/skills-hub.md)。

## 共享模式：接管 → 集中 → 分发

两个 hub 解决的是同一个问题：一位开发者同时运行 Claude Code、Cursor、Codex 和 Gemini，而每一款都保有自己那份「有哪些 MCP 服务器」和「装了哪些 skills」的副本。什么都不共享，编辑各自漂移，而机密以明文躺在配置文件里。

Chronicle 的答案是每种资源一个控制平面：

| 阶段 | MCP Hub（`server/mcp/`） | Skills Hub（`server/skills.js`） |
| --- | --- | --- |
| **接管** | `scanMcpConfigs()` 读取每款工具的配置；`classifyScan()` 与注册表做差异比对 | `scanSkills()` 读取每款工具的 `skills/` 目录，解析 `SKILL.md` |
| **集中** | `upsertService()` 写入 `mcp_services` 表 | `importSkill()` 把目录复制进 `~/.chronicle/skills` |
| **分发** | `/mcp` 端点把每个服务重新暴露为命名空间化的 `service__tool` | `linkSkill()` 把中央副本符号链接进每款工具的 `skills/` 目录 |

让接管值得信任的那条安全规则，在两者中是相同的：**源永远不会被改写。** MCP 接管在触碰注册表之前会备份每一份源配置；skill 导入是*复制*进中央存储、并让源目录保持原样；skill 分发只会*添加*一个符号链接，并拒绝覆盖一个真实目录。如果 Chronicle 明天凭空消失，每款工具自己的配置仍会分毫不差地待在原处。

## MCP Hub

### 服务注册表（`server/mcp/registry.js`）

注册表是覆盖在单张 SQLite 表 `mcp_services` 之上的一层薄薄的 CRUD，外加填充它的那些扫描器。一条服务行携带一种传输方式（`stdio | http | sse`）、启动细节（stdio 用 `command`/`args`/`env`，HTTP 用 `url`/`headers`）、一个 `enabled` 标志、它来自的 `origin` 配置、一个按服务的 `disabled_tools` 策略列表，以及一个可选的 `project_path` 作用域。

核心 CRUD：

```js
listServices()                    // all rows, ordered by name
upsertService(entry)              // insert-or-update keyed on unique name
setServiceEnabled(id, enabled)    // policy on/off
deleteService(id)
maskService(s)                    // redact secret-looking env/header values for display
```

`maskService()` 是展示关口：每一个离开 API 的注册表值（`GET /api/mcp/services`、`/api/mcp/scan`）都先经它处理，因此令牌、密钥和 `Authorization` 头返回时是 `abcd…******` 而非明文。UI 里任何东西都永远看不到一份原始凭据。

**扫描与分类。** `scanMcpConfigs()` 读取已知的配置位置——`~/.claude.json`（外加已导入项目的按项目 `.mcp.json`）、`~/.cursor/mcp.json`、`~/.gemini/settings.json`，以及 `~/.codex/config.toml`（通过一个极简的内联 TOML 读取器，因为 Codex 使用 `[mcp_servers.<name>]` 小节）。`classifyScan()` 随后把每个发现的服务器与注册表做差异比对并打上标签：

| 状态 | 含义 |
| --- | --- |
| `new` | 尚未在注册表中 |
| `unchanged` | 已存在且完全相同 |
| `updated` | 已存在、有变更，且来自**同一份**源配置 |
| `conflict` | 已存在、有变更，但来自一份**不同的**源 |

New/Updated/Conflict 这种拆分正是驱动接管审阅 UI 的东西——你能清楚看到一次一键导入会添加什么、又会覆盖什么。

**接管前先备份。** `backupSources()` 会在任何接管之前，把每一份源配置文件复制进 `~/.chronicle/backups/mcp/<timestamp>/`，并保留最近五套备份。这就是代码中「默认安全」的保证：采纳是可逆的。

**项目作用域与 Roots。** 一个服务可以通过 `setProjectPath()` 绑定到某个 `project_path`。`servicesForRoot(root)` 随后按**最长前缀匹配**来路由：给定客户端的一个 root，它返回所有全局作用域的服务，外加其路径是该 root 前缀的、*最深*的那个项目作用域。传入 `'*'` 返回一切（管理/检查视图）；不传 root 则只返回全局服务。这正是一个 hub 端点如何能向在不同仓库中工作的客户端暴露不同工具集的方式。

**凭据与工具策略。** `setCredential(id, bearer)` 把一个按服务的 bearer 令牌存为 `Authorization` 头（在输出中处处被掩码，在上游调用时被施加）。`setDisabledTools(id, tools)` 记录一个按服务的屏蔽列表；被禁用的工具会从 `tools/list` 中隐藏，并在 `tools/call` 时被拒绝。

### `/mcp` 端点（`server/mcp/hub.js`）

hub 是一个挂载在 `/mcp` 的 Express 应用，讲的是 **MCP Streamable HTTP，协议版本 `2025-03-26`**。它刻意以 POST 为先：客户端通过 `POST /` 发送 JSON-RPC，`DELETE /` 拆除一个会话，而 `GET /` 返回 `405`（不提供服务器发起的 SSE 流，因此客户端回退到仅 POST 模式）。

每一个请求前面都坐着两道防护：

- **Origin 校验（CSRF）。** 一个携带浏览器 `Origin` 头的请求会被以 `403` 拒绝，除非该 origin 是 `localhost`/`127.0.0.1`。非浏览器的 MCP 客户端（不发送 `Origin`）则放行通过。
- **会话身份。** `initialize` 会铸造一个 `MCP-Session-Id`（一个 UUID），在响应头中返回；客户端在后续调用中回显它。该会话还记录客户端的 **root**——来自一个 `x-chronicle-root` 头，或 `initialize` 参数里的 `rootUri` / `workspaceFolders`——这正是后续 `tools/list` 调用据以作用域限定的东西。

**聚合与命名空间化。** `aggregateTools(root)` 是 hub 的核心。它调用 `servicesForRoot(root)` 挑出作用域内的服务，并行连接到每一个，并把它们的工具压平成一个列表——把每个工具重命名为 `<service>__<tool>`，并给其描述加上 `[<service>]` 前缀：

```js
tools.push({
  ...t,
  name: `${svc.name}${SEP}${t.name}`,          // SEP = "__"
  description: `[${svc.name}] ${t.description ?? ''}`,
});
```

位于服务 `disabled_tools` 列表上的工具会在此被过滤掉。上游连接错误不会让整个列表失败——它们会被按服务收集进一个 `errors` 映射，好让一个坏掉的服务器不至于把 hub 整个清空。

**分派。** `callTool(namespaced, args)` 在第一个 `__` 处切分，按名称解析出服务，并在转发前施加策略：一个被禁用的服务或一个被策略屏蔽的工具会抛错（并且该屏蔽会作为一条 `blocked` 记录写入检查器日志）。否则它把 `tools/call` 转发给上游客户端，并原样返回结果。

**上游传输（`server/mcp/upstream.js`）。** `connect(service)` 桥接两类上游：

- **stdio** —— 派生子进程，通过其 stdin/stdout 讲以换行分隔的 JSON-RPC，并把**存活的子进程缓存**在 `globalThis.__chronicleUpstreams` 上，好让重复调用复用同一个进程（并在 Vite SSR 重载中存活）。子进程只初始化一次（`initialize` → `notifications/initialized` → `tools/list`）。
- **http / sse** —— 一个基于 `fetch` 的 Streamable-HTTP 客户端，按 hub 会话廉价地重新初始化，能处理 JSON 与 `text/event-stream` 两种响应，并把上游自己的 `MCP-Session-Id` 穿针引线地传递下去。

于是一个 stdio 服务器和一个远程 HTTP 服务器对下游客户端看起来是一模一样的：两者都在同一个扁平列表里以 `service__tool` 名称浮现。

**状态与检查器。** `hubStatus()` 报告端点、协议版本、服务/启用计数、存活会话数以及已连接的 stdio 子进程。`hubLog()` 返回那个环形缓冲区（最近约 300 条），记录每一条进出的 JSON-RPC 消息——recv/send/blocked/note。那份日志加上手动的 `tools/call` 就是内置的**检查器**（`GET /api/mcp/log`、`GET /api/mcp/tools`、`POST /api/mcp/call`），一种无需外部 MCP 客户端就能演练 hub 的自包含方式。

> **注意：** `/mcp` 端点（那个聚合式 MCP 服务器）不同于 `/api/mcp/*` 路由（那个用来列出服务、运行扫描并驱动接管的管理 REST API）。见 [API 参考](api-reference.md)。

## Skills Hub（`server/skills.js`）

Skills Hub 集中管理智能体 skills——一个个自包含、带有 `SKILL.md` 的目录——方式与 MCP Hub 集中管理服务器如出一辙。它的中央存储是：

```js
export const CENTRAL_SKILLS = path.join(HOME, '.chronicle', 'skills');
```

### 扫描与导入

`scanSkills()` 遍历每款工具的 skill 目录（`~/.claude/skills`、`~/.agents/skills`、`~/.cursor/skills`、`~/.codex/skills`、`~/.gemini/skills`），解析 `SKILL.md` frontmatter 里的 `name`/`description`，并把每个条目归入四个层级之一：

| 层级 | 含义 |
| --- | --- |
| `importable` | 一个尚未进入中央存储的真实 skill 目录 |
| `managed` | 一个已经指向 `CENTRAL_SKILLS` 的符号链接 |
| `duplicate` | 一个其名称在中央已经存在的 skill |
| `broken` | 一个悬空的符号链接，或一个没有 `SKILL.md` 的目录 |

`importSkill(sourcePath, origin)` 把该目录复制进中央存储（必要时用数字后缀去重名称），并在 `skills` 表中记一行。源目录是被复制的，绝不是被移动——原本的工具安装分毫未动。

`listSkills()` 返回每一个中央 skill，并附上 `linkStatus()` 的标注——针对每款工具，说明 Chronicle 在那里是有一个存活的符号链接、一个外来链接、一个真实目录，还是什么都没有。

### 符号链接扇出 —— 严格只增

分发是接管的刻意反面：Chronicle 不是把文件到处复制，而是把那一份中央副本**符号链接**进每款工具的 skills 目录，于是每款工具看到的是同一个 skill，一次编辑会一次性传播到所有地方。

`linkSkill(skillId, tool)` 创建符号链接，但**拒绝覆盖**：如果一个真实目录或一个外来链接已占据那个路径，它会抛错而不是替换它（在 Windows 上它使用 `junction`，因此无需管理员权限）。`unlinkSkill(skillId, tool)` 是它的镜像，也是核心的安全保证——**它只移除 Chronicle 自己创建的符号链接**（通过把它解析回 `CENTRAL_SKILLS` 来核验）；指向一个真实目录时它会拒绝并抛错。Chronicle 永远无法删除一款工具真正拥有的 skill。

`updateSkillMeta(id, {tags, rating})` 存储仅限本地的组织元数据——即活在 Chronicle 数据库里、永不上传到任何地方的标签和星级评分。

### 版本历史与快照

每一个中央 skill 都在 `~/.chronicle/snapshots/<skill>/` 下获得一份自动版本历史，由 `takeSnapshot(skillId, trigger)` 管理：

- **`imported`** 快照是永久的——即导入时刻那份原始状态。
- **`fs_change`** 快照由 `startSkillWatcher()` 拍摄，它是一个对中央存储的 `fs.watch`，每个 skill 带 **500 毫秒防抖**，并以**滚动的 50 个**保留（最旧的被剪除）。
- 快照按**内容哈希去重**：`takeSnapshot` 对目录树做哈希，如果自上一张快照以来什么都没变就跳过写入（`imported` 除外，它总是被保留）。

`listSnapshots()` / `restoreSnapshot(skillId, snapshotId)` 提供一键恢复。恢复会先把当前状态自动拍成一张快照（以 `restore` 触发），然后替换中央目录——而因为分发是靠符号链接，每款工具的链接都能在这次交换中继续工作，无需任何重新链接。

### GitHub 导入与上游跟踪

`importFromGithub(repoUrl, branch='main', subpath='')` 做一次**浅克隆**（`git clone --depth 1`）到一个临时目录，记录解析出的提交 SHA，向下最多走五层去找每一个含有 `SKILL.md` 的目录，逐个导入，给它们打上 `origin_repo`/`origin_sha` 标签，拍一张 `imported` 快照，然后清理掉克隆。只接受公开的 HTTPS URL。

`checkUpstream(skillId)` 用 `git ls-remote` 把记录下来的 SHA 与远端 tip 做比对——不做克隆，只查一个 ref——于是你一眼就能看出一个来自 GitHub 的 skill 是否已偏离其源头。

## 为什么是这个形状

两个 hub 都是覆盖在其他工具状态之上的、以读为主的控制平面，因此其设计重重地压在非破坏性上：接管前先备份，导入时复制（绝不移动），只增的符号链接外加一条严格的「只移除我们造的」规则，并在输出的路上掩码每一份凭据。这正是让人可以放心把 Chronicle 指向一位开发者真实、在用的配置的原因——最坏情形是一个过期的符号链接，而绝不是一份丢失的配置或一份泄漏的机密。这如何契合六条产品原则，见 [架构总览](overview.md)。

## 相关

- [MCP Hub](../guide/mcp-hub.md) —— 面向用户的指南：接管、策略、检查器、Roots。
- [Skills Hub](../guide/skills-hub.md) —— 中央存储、符号链接扇出、GitHub 导入、版本管理。
- [API 参考](api-reference.md) —— `/api/mcp/*` 管理路由与 `/mcp` 端点。
