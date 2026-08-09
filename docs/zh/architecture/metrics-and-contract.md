# 指标与契约视图

Chronicle v0.2 将数据库变成一个可供外部消费者读取的**指标基座 (metrics substrate)**：逐消息的 token 用量、侧链（子代理）归因、存储的时长指标、带版本的 SQL 契约视图，以及一个 FTS5 全文索引。本页记录这些模式新增，以及外部读取方可以依赖的契约。

设计约束与 Chronicle 其他各处一致：一切都在导入时从日志本地计算——没有 LLM 调用、没有网络，并且由于消费者只读取视图，基础表可以自由重构。

## 侧链与归因列（`messages`）

所有新增都是 `server/db.js` 中幂等的 `ALTER TABLE` 迁移，遵循既有模式。

| 列 | 类型 | 由谁设置 | 含义 |
| --- | --- | --- | --- |
| `is_sidechain` | INTEGER (0/1) | 所有解析器 | `1` = 子代理/侧链事件。Claude Code 解析器现在会**导入**侧链行而不再丢弃它们 |
| `agent_type` | TEXT | Claude Code 解析器 | 侧链行的子代理类型（例如 `Explore`、`general-purpose`），通过将侧链的第一条用户消息与主链的 `Task`/`Agent` `tool_use` 输入（`subagent_type`）配对得出。未匹配到或主链行上为 `NULL` |
| `skill` | TEXT | Claude Code 解析器 | 活跃的 skill 上下文：在 `Skill` 调用的 `tool_use` 行和 `<command-name>` 轮次的行上设置，其余为 `NULL`。跨度式的「从调用到下一个用户轮次之间的消息」归因被有意**放弃**——过于启发式；消费者应按调用分组 |

`sessions` 新增 `sidechain_count`（一个廉价的反规范化，供卡片和分析使用）。

值得了解的范围规则：`sessions.context_tokens` 保持原有定义（最后一次**主链** API 调用，与 Claude Code 自身状态行一致）。成本与用量合计以及 Agent Active 现在**包含**侧链；默认的消息计数、回放和提炼则**排除**它们（UI 上按 `is_sidechain = 0` 过滤）。

## 逐消息 token 列（`messages`）

assistant 行上的五个 INTEGER 列：`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_w5m_tokens`、`cache_w1h_tokens`。

一次 API 调用 = 一组数字，存储在**该调用的第一个事件上**（同一调用的其他事件为 `NULL`）。这就是解锁「最昂贵消息排行」和按美元加权的 skill/工具归因的关键——仅靠会话级的 `sessions.usage` JSON 无法回答这些问题。侧链用量也被计入（此前它被整个丢弃）。非 Claude 解析器在其日志携带用量时也会填充这些列；美元成本仍由消费者侧计算（静态价格表，即 `src/models.js` 的模式）——**数据库存储 token，永不存储美元**。

## 时长指标（存储在 `sessions` 上）

两个指标都在导入时由一个共享的服务端模块计算并存储，因此 UI 和契约视图读取同一个数字，而不是在客户端各自重新推导。

**`agent_active_ms`** —— 规范的「Agent Active」。对连续消息间隔求和（所有行，含侧链，按 `ts` 排序——单次按时间线扫描，因此重叠的侧链时间不会被重复计入），规则为：

1. 通向一条**真正的人类提示**的间隔（由 `SYNTHETIC_USER_RE` 分类器判定——并非每一条 `user` 角色行都是人类）→ **完全排除**；
2. 以匹配到先前 `tool_use` 的 `tool_result` 结尾的间隔 → **全额计入**（真实的工具/构建时间，无上限）；
3. 权限批准交互 → 视为人类提示（排除）；
4. 其他所有间隔 → 计入，每段**上限 10 分钟**。

**`engaged_ms`** —— 「Engaged time」，扩展风格的动手时间：**所有**消息间隔之和，每段**上限 90 分钟**，不区分人类/合成消息。

无上限的首尾跨度仍是 Total Duration。在概览中，Agent Active 保留其统计卡片，Engaged time 作为次要行出现，各自带有自己的 ⓘ 解释。

## 契约视图与 `user_version`

外部消费者（例如一个仪表盘）**只**读取 `contract_*` 视图——一个只读的**指标**表面，**不含内容列**（没有消息文本，没有工具输入）。只要视图保持形状不变，基础表就可以自由重构。

```sql
-- One row per message: metrics + pointers, NO content columns.
CREATE VIEW contract_message_metrics AS
SELECT m.session_id, m.seq, m.ts, m.kind, m.model,
       m.is_sidechain, m.agent_type, m.skill,
       m.tool_name,
       CASE WHEN m.tool_name LIKE 'mcp__%'
            THEN substr(m.tool_name, 6, instr(substr(m.tool_name, 6), '__') - 1)
       END AS mcp_server,
       m.input_tokens, m.output_tokens, m.cache_read_tokens,
       m.cache_w5m_tokens, m.cache_w1h_tokens,
       s.file_path AS source_file
FROM messages m JOIN sessions s ON s.id = m.session_id;

-- One row per session: identity, span, usage JSON, stored durations.
CREATE VIEW contract_sessions AS
SELECT s.id, s.source, p.path AS project_path, s.file_path,
       s.started_at, s.ended_at, s.message_count, s.sidechain_count,
       s.context_tokens, s.usage,
       s.agent_active_ms, s.engaged_ms
FROM sessions s JOIN projects p ON p.id = s.project_id;
```

汇总（按 skill、按模型、最昂贵消息）可由消费者从这两个视图自行推导；Chronicle 不做预聚合。

**版本契约：** 迁移时设置 `PRAGMA user_version = 1`。**只有破坏性的视图变更才会递增它**——新增列不会。消费者必须检查 `user_version`，遇到 `0` 或未知值时应**大声拒绝**，而不是猜测数据形状。

## FTS5 全文索引

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(text, tool_input, content=messages, content_rowid=id);
```

一个覆盖 `messages.text` 与 `tool_input` 的 external-content FTS5 表。它在 `replaceSession` 内部填充——因为导入是对整个会话的删除后重插，在同一事务中重建该会话的 FTS 行即可保持索引一致，**无需触发器**。

`GET /api/search` 使用 FTS5 `MATCH`，响应形状与之前相同，并在 FTS 表缺失时**回退到 `LIKE`**。Node 自带的 SQLite 包含 FTS5；可用性在启动时验证，该功能软失败——搜索始终可用，FTS 只是让它更快。

## 相关内容

- [数据模型](data-model.md) —— 这些列和视图所依托的基础表，以及 `replaceSession`。
- [会话洞察](../guide/session-insights.md) —— 时长、成本与用量的用户侧视图。
- [搜索与筛选](../guide/search-and-filtering.md) —— 由 FTS5 索引支撑的全局搜索。
- [API 参考](api-reference.md) —— `/api/search` 路由。
