# HTTP API 参考

Chronicle 在一个本地端口上暴露三个挂载点：`/api`（REST API）、`/share`（公开的脱敏页面）和 `/mcp`（聚合式 MCP 服务器）。本页是面向贡献者、以及任何针对一个运行中实例编写脚本的人的、路由级别的参考。

一切都从单一 origin 提供——dev（`npm run dev`）下是 `http://localhost:4173`，desktop/standalone 下是 `http://localhost:41730`——并且完全相同的 Express 应用支撑着全部三种运行模式（见 [架构总览](overview.md)）。请求仅限本地；standalone 服务器绑定 `127.0.0.1`。

## 挂载点

| 挂载点 | 源 | 提供什么 |
| --- | --- | --- |
| `/api` | `server/api.js` | REST API —— 除非另有说明，下面的每一条路由 |
| `/share` | `server/shares.js` | 公开的、脱敏的、带令牌的会话页面（HTML） |
| `/mcp` | `server/mcp/hub.js` | 聚合式 MCP 服务器（Streamable HTTP、JSON-RPC） |

> **注意：** `/mcp`（MCP 协议端点）与 `/api/mcp/*` 路由（那个列出服务并驱动接管的管理 REST API）是**不同的**东西。下游 MCP 客户端与 `/mcp` 对话；Chronicle UI 与 `/api/mcp/*` 对话。见 [MCP 与 Skills 内部机制](mcp-and-skills-internals.md)。

下面各表中的所有路径都相对于 `/api`——例如 `GET /projects` 就是 `GET http://localhost:41730/api/projects`。

## 导入与扫描

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/scan` | 发现横跨全部六款工具的可导入会话（按逻辑项目分组） |
| `POST` | `/import` | 把所选会话导入 SQLite 存储（每个会话一次 `replaceSession`） |

## 项目

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects` | 列出项目并附带实时的 git 药丸信息（`repoInfo` 每次调用都运行 `git`） |
| `GET` | `/projects/:id` | 项目分析主页；接受 **`?days=N`** 以限定时间范围 |
| `PATCH` | `/projects/:id` | 重命名一个项目 |
| `DELETE` | `/projects/:id` | 从 Chronicle 删除一个项目及其会话 |
| `POST` | `/projects/:id/associate` | 把一个虚拟项目（如 Gemini）关联到一个真实的仓库路径 |
| `POST` | `/projects/:id/sync` | 重新扫描并重新导入一个项目的全部会话 |
| `POST` | `/projects/:id/unlink` | 撤销一次关联 |

## 会话

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/sessions/:id/messages` | 一个会话的完整消息列表 |
| `PATCH` | `/sessions/:id` | 重命名一个会话（设置用户的 `name` 覆盖值） |
| `DELETE` | `/sessions/:id` | 删除一个会话的 Chronicle 副本 |
| `DELETE` | `/sessions/:id/source-file` | 删除底层的源日志（仅当一个文件 = 一个会话时） |
| `POST` | `/sessions/:id/sync` | 只重新导入这一个会话（UI 中的 `⇧⌘U`） |
| `GET` | `/sessions/:id/causality` | 读→改因果关系分析（`analyzeCausality`） |
| `GET` | `/sessions/:id/live` | **SSE 流** —— 实时消息 tail（见下文） |
| `GET` | `/sessions/:id/security-check` | 为机密扫描该会话（`scanSession` 负载） |
| `GET` | `/sessions/:id/export-redacted` | 把会话导出为脱敏后的 Markdown |
| `POST` | `/sessions/:id/share` | 铸造一个分享令牌（脱敏副本在创建时冻结） |
| `GET` | `/sessions/:id/replay-plan` | 构建回放步骤计划（`buildPlan`） |

### 实时 SSE 流

`GET /api/sessions/:id/live` **不是** JSON——它升级为 `text/event-stream` 并推送 `data:` 帧。帧要么是 `{ type: 'status', status: 'live' | 'stopped', ... }`，要么是 `{ type: 'messages', events: [...] }`。watcher 会在连接关闭时自动停止。见 [安全、实时与回放内部机制](security-live-replay.md)。

## Git

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/git/at` | 位于某个时间戳处或之前、最接近的提交（`commitAt`） |
| `GET` | `/git/tree` | 某次提交处的文件树（`treeAt`） |
| `GET` | `/git/file` | 某次提交处一个文件的内容 + 用于差异的上一个版本（`fileAt`） |

这些是覆盖在 `server/git.js` 之上的只读封装，它通过 shell 调用 `git`。见 [Git 快照引擎](git-snapshot-engine.md)。

## 搜索

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/search` | 基于 `LIKE` 的全文搜索，覆盖 `messages.text` + `tool_input`，按会话分组（空查询 → 近期会话） |

## 实时

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/live/status` | 列出活跃的实时 watcher（`liveStatus`） |

## 安全

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/security/rules` | 列出脱敏/allow 规则 |
| `POST` | `/security/rules` | 添加一条自定义规则 |
| `PATCH` | `/security/rules/:id` | 启用/禁用一条规则 |
| `DELETE` | `/security/rules/:id` | 删除一条规则 |
| `GET` | `/security/interceptions` | 近期的工具调用前拦截记录 |
| `POST` | `/security/pretooluse` | 扫描一次工具调用；返回 `{ decision: 'allow' \| 'block', ... }`（由钩子调用） |
| `POST` | `/security/install-hook` | 安装 Claude Code PreToolUse 钩子（先备份设置） |

## Skills

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/skills` | 列出中央 skills（附带按工具的链接状态） |
| `GET` | `/skills/scan` | 扫描工具目录，找出 importable/managed/duplicate/broken 的 skills |
| `POST` | `/skills/import` | 把一个扫描到的 skill 导入中央存储 |
| `POST` | `/skills/github` | 从一个公开 GitHub 仓库导入 skills（浅克隆，记录 SHA） |
| `GET` | `/skills/:id` | Skill 详情 + `SKILL.md` 内容 |
| `PATCH` | `/skills/:id` | 更新本地元数据（标签、评分） |
| `DELETE` | `/skills/:id` | 删除一个 skill（`?removeFiles=1` 以移除中央文件） |
| `POST` | `/skills/:id/link` | 把该 skill 符号链接进一款工具的目录 |
| `POST` | `/skills/:id/unlink` | 移除一个 Chronicle 创建的符号链接 |
| `GET` | `/skills/:id/snapshots` | 列出版本快照 |
| `POST` | `/skills/:id/restore` | 恢复一张快照 |
| `POST` | `/skills/:id/check-upstream` | 把记录下来的 SHA 与远端 tip 做比对（`ls-remote`） |

## MCP 管理

这些管理注册表并驱动 hub；它们与 `/mcp` 协议端点是分开的。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/mcp/services` | 列出已注册的服务（机密已掩码） |
| `POST` | `/mcp/services` | 添加/更新一个服务 |
| `PATCH` | `/mcp/services/:id` | 更新一个服务（启用、作用域、凭据、工具策略） |
| `DELETE` | `/mcp/services/:id` | 移除一个服务 |
| `GET` | `/mcp/scan` | 扫描工具配置，分类为 New/Updated/Conflict/Unchanged |
| `POST` | `/mcp/takeover` | 导入扫描到的服务（先备份源配置） |
| `GET` | `/mcp/status` | Hub 状态（协议版本、服务/会话计数） |
| `GET` | `/mcp/tools` | 聚合后的工具列表（`aggregateTools('*')`）—— 检查器 |
| `POST` | `/mcp/call` | 调用一个命名空间化的 `service__tool` —— 检查器 |
| `GET` | `/mcp/log` | hub 的 JSON-RPC 环形缓冲区日志 —— 检查器 |

## 回放

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/replay/preview` | 预览一个即将到来的步骤相对沙箱状态的差异 |
| `POST` | `/replay/start` | 从会话开始的快照创建/播种沙箱 |
| `POST` | `/replay/step` | 执行一个步骤（Bash 需要 `{ confirmCommand }`） |
| `POST` | `/replay/open` | 在操作系统的文件浏览器中打开沙箱 |

## 反馈

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/feedback` | 追加到 `~/.chronicle/feedback.log` 并转发给托管中继 |

## 分享管理

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/shares` | 列出分享令牌（查看数、过期时间） |
| `DELETE` | `/shares/:id` | 撤销一个分享 |

以及在 `/share` 挂载点上：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/share/:token` | 公开的脱敏 HTML 页面（一旦过期/撤销即返回 404） |

## 数据形状

消息行与会话行遵循归一化事件模型——SQLite schema、`kind` 枚举（`user \| assistant \| thinking \| tool_use \| tool_result`，外加 `note`），以及 `replaceSession()` 如何在保留用户设置的 `name` 的同时让导入幂等，见 [数据模型](data-model.md)。

有一个值得在这里点明的形状：按会话的 `sessions.usage` 列是以模型为键的 JSON，并带有拆分的缓存写入桶：

```json
{
  "claude-opus-4-8": {
    "input": 12000,
    "output": 3400,
    "cacheWrite5m": 800,
    "cacheWrite1h": 0,
    "cacheRead": 45000
  }
}
```

成本由 `src/models.js`（一张静态价格表）据此在本地计算——日志携带的是 token，从来不是美元。

## 相关

- [架构总览](overview.md) —— 单进程 / 单端口、运行模式、组件地图。
- [MCP 与 Skills 内部机制](mcp-and-skills-internals.md) —— `/mcp` 端点与 `/api/mcp/*` 的分野。
- [数据模型](data-model.md) —— 这些路由背后的 SQLite schema 与归一化事件模型。
