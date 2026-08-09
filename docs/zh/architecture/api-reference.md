# HTTP API 参考

Chronicle 在一个本地端口上暴露两个挂载点：`/api`（REST API）和 `/share`（公开的脱敏页面）。本页是面向贡献者、以及任何针对一个运行中实例编写脚本的人的、路由级别的参考。

一切都从单一 origin 提供——dev（`npm run dev`）下是 `http://localhost:4173`，desktop/standalone 下是 `http://localhost:41730`——并且完全相同的 Express 应用支撑着全部三种运行模式（见[架构总览](overview.md)）。请求仅限本地；standalone 服务器绑定 `127.0.0.1`。

> **想直接读数据库？** 外部消费者应读取带版本号的 `contract_*` SQL 视图，而不是这些路由——见[指标与契约视图](metrics-and-contract.md)。

## 挂载点

| 挂载点 | 源码 | 提供内容 |
| --- | --- | --- |
| `/api` | `server/api.js` | REST API——除非另有说明，下面的每个路由都属于它 |
| `/share` | `server/shares.js` | 公开的、脱敏的、按 token 访问的会话页面（HTML） |

下表中的所有路径都相对于 `/api`——例如 `GET /projects` 就是 `GET http://localhost:41730/api/projects`。

## 导入与扫描

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/scan` | 跨全部六款工具发现可导入的会话（按逻辑项目分组） |
| `POST` | `/import` | 将选中的会话导入 SQLite 存储（每会话一次 `replaceSession`） |

## 项目

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects` | 列出项目并附带实时 git 徽标信息（`repoInfo` 每次调用都会执行 `git`） |
| `GET` | `/projects/:id` | 项目分析主页；接受 **`?days=N`** 来限定时间范围 |
| `PATCH` | `/projects/:id` | 重命名项目 |
| `DELETE` | `/projects/:id` | 从 Chronicle 中删除项目及其会话 |
| `POST` | `/projects/:id/associate` | 将虚拟项目（如 Gemini）关联到真实仓库路径 |
| `POST` | `/projects/:id/sync` | 重新扫描并重新导入该项目的所有会话 |
| `POST` | `/projects/:id/unlink` | 撤销一次关联 |

## 会话

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/sessions/:id/messages` | 会话的完整消息列表 |
| `PATCH` | `/sessions/:id` | 重命名会话（设置用户 `name` 覆盖） |
| `DELETE` | `/sessions/:id` | 删除 Chronicle 中该会话的副本 |
| `DELETE` | `/sessions/:id/source-file` | 删除底层源日志（仅限一文件一会话的来源） |
| `POST` | `/sessions/:id/sync` | 只重新导入这个会话（UI 中的 `⇧⌘U`） |
| `GET` | `/sessions/:id/causality` | 读取→变更的因果分析（`analyzeCausality`） |
| `GET` | `/sessions/:id/live` | **SSE 流**——实时消息尾随（见下文） |
| `GET` | `/sessions/:id/security-check` | 扫描会话中的密钥（`scanSession` 载荷） |
| `GET` | `/sessions/:id/export-redacted` | 将会话导出为脱敏的 Markdown |
| `POST` | `/sessions/:id/share` | 铸造一个分享 token（脱敏副本在创建时冻结） |
| `GET` | `/sessions/:id/replay-plan` | 构建回放步骤计划（`buildPlan`） |

### 实时 SSE 流

`GET /api/sessions/:id/live` **不是** JSON——它升级为 `text/event-stream` 并推送 `data:` 帧。帧要么是 `{ type: 'status', status: 'live' | 'stopped', ... }`，要么是 `{ type: 'messages', events: [...] }`。连接关闭时监视器自动停止。见[安全、实时与回放内部机制](security-live-replay.md)。

## Git

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/git/at` | 时间戳当时或之前最近的提交（`commitAt`） |
| `GET` | `/git/tree` | 某次提交时的文件树（`treeAt`） |
| `GET` | `/git/file` | 某次提交时文件的内容 + 其上一个版本用于 diff（`fileAt`） |

这些是 `server/git.js` 的只读封装，后者调用外部 `git`。见 [Git 快照引擎](git-snapshot-engine.md)。

## 搜索

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/search` | 对 `messages.text` + `tool_input` 的全文搜索（FTS5 `MATCH`，若 FTS 表缺失则回退到 `LIKE`），按会话分组（空查询 → 最近会话） |

## 实时

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/live/status` | 列出活跃的实时监视器（`liveStatus`） |

## 安全

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/security/rules` | 列出脱敏/放行规则 |
| `POST` | `/security/rules` | 添加自定义规则 |
| `PATCH` | `/security/rules/:id` | 启用/禁用规则 |
| `DELETE` | `/security/rules/:id` | 删除规则 |

## 回放

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/replay/preview` | 预览即将到来的步骤相对沙箱状态的 diff |
| `POST` | `/replay/start` | 从会话开始时的快照创建/播种沙箱 |
| `POST` | `/replay/step` | 执行一个步骤（Bash 需要 `{ confirmCommand }`） |
| `POST` | `/replay/open` | 在操作系统的文件浏览器中打开沙箱 |

## 反馈

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/feedback` | 追加到 `~/.chronicle/feedback.log` 并转发到托管中继 |

## 分享管理

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/shares` | 列出分享 token（访问次数、过期时间） |
| `DELETE` | `/shares/:id` | 撤销一个分享 |

以及在 `/share` 挂载点上：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/share/:token` | 公开的脱敏 HTML 页面（过期/撤销后返回 404） |

## 数据形状

消息与会话行遵循归一化事件模型——SQLite 模式、`kind` 枚举（`user \| assistant \| thinking \| tool_use \| tool_result`，外加 `note`），以及 `replaceSession()` 如何在保持导入幂等的同时保留用户设置的 `name`，见[数据模型](data-model.md)。

有一个形状值得在此点出：按会话的 `sessions.usage` 列是以模型为键的 JSON，缓存写入分桶存放：

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

## 相关内容
- [架构总览](overview.md) — 单进程/单端口、运行模式、组件地图。
- [指标与契约视图](metrics-and-contract.md) — 面向外部读取者的带版本 `contract_*` 视图，以及 `/search` 背后的 FTS5 索引。
- [数据模型](data-model.md) — 这些路由背后的 SQLite 模式与归一化事件模型。
