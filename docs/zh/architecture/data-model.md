# 数据模型

Chronicle 把一切都存进单个本地 SQLite 数据库——三张表（`projects`、`sessions`、`messages`）——并且每个解析器都把它工具原生的日志压平成同一种归一化事件形状，因此 UI 永远无需关心某个会话来自哪里。

本页涵盖数据存储（`server/db.js`）、三张表及其迁移列、六个解析器共享的归一化事件模型，以及 `replaceSession()`——那个幂等的导入事务，它悄悄地保住了用户唯一手动键入的东西。

## 数据存储

数据库位于 `~/.chronicle/chronicle.db`，通过 Node 内置的 SQLite 打开：

```js
// server/db.js
import { DatabaseSync } from 'node:sqlite';
const dataDir = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
export const db = new DatabaseSync(path.join(dataDir, 'chronicle.db'));
```

这里有两个重要决策：

- **用 `node:sqlite`，而不是 better-sqlite3。** 它随 Node 一起发布，因此没有需要按平台编译或重建的原生模块——这是零工具链构建的硬性要求。可以用 `CHRONICLE_DATA_DIR` 覆盖数据目录（对测试和一次性实例很方便）。
- **模式在模块加载时被幂等地创建。** 每次模块加载时 `db.exec()` 都会运行完整的 `CREATE TABLE IF NOT EXISTS …` 块，模式变更则以尽力而为的迁移方式应用：

```js
// Idempotent migrations — safe to run on every boot
try { db.exec('ALTER TABLE sessions ADD COLUMN context_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN name TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN usage TEXT'); } catch {}
```

没有迁移框架，也没有版本表。新增一列就是一行 `try { ALTER TABLE … } catch {}`：升级后的第一次启动会把它加上，之后的每次启动都在 `catch` 中空转。这已经够用，因为模式很小且只增不减，同时保住了"直接运行就行"的特性——没有可被遗忘的独立迁移步骤。

## 三张表

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,          -- physical cwd (or a gemini-project:<hash> virtual path)
  name TEXT NOT NULL,                 -- basename(path), shown on the project card
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- the tool's own session id
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,              -- claude-code | codex | cursor | opencode | gemini-cli | copilot-chat
  file_path TEXT NOT NULL,          -- source log this session was parsed from
  started_at TEXT, ended_at TEXT,
  message_count INTEGER DEFAULT 0,
  first_prompt TEXT
  -- migration columns: context_tokens, name, summary, usage
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,             -- 0-based order within the session
  uuid TEXT, ts TEXT,
  kind TEXT NOT NULL,               -- user|assistant|thinking|tool_use|tool_result|note
  text TEXT,
  tool_name TEXT, tool_input TEXT,  -- tool_input is a JSON string
  tool_use_id TEXT,                 -- pairs a tool_use with its tool_result
  model TEXT
);

CREATE INDEX idx_messages_session ON messages(session_id, seq);
CREATE INDEX idx_sessions_project ON sessions(project_id);
```

**`projects`** 以 `path` 为键——即日志中记录的物理 `cwd`（当工具不记录 cwd 时则是虚拟的 `gemini-project:<hash>`）。一个物理目录就是一个逻辑项目，无论有多少工具在其中工作过。`upsertProject(physicalPath)` 对唯一的 `path` 执行 insert-or-ignore 并返回该行。

**`sessions`** 承载身份与摘要字段。基础列是最初的模式；四个**迁移列**是后来添加的，这正是它们采用 `ALTER TABLE` 而不是写进 `CREATE` 的原因：

| 列 | 数据来源 | 为何是迁移列 |
| --- | --- | --- |
| `context_tokens` | 最后一次主链 API 调用的 prompt 侧 | 随上下文窗口条一起加入；**仅在导入时设置**——升级后需重新导入或 Sync Update 才能回填 |
| `name` | 用户在 Chronicle 中键入的重命名 | 随内联重命名一起加入；表中唯一由用户撰写的字段 |
| `summary` | 解析出的工具标题（Claude Code `custom-title`，最后一个生效） | 随自动标题一起加入；每次导入重新推导 |
| `usage` | 按模型的 token 总量 JSON | 随 Cost & Usage 面板一起加入；每次导入重新推导 |

`usage` JSON 的形状是 `{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}`——5 分钟和 1 小时缓存写入被拆开存放，因为两者计费费率不同（见[会话洞察](../guide/session-insights.md)）。

> **v0.2 新增。** `messages` 获得了 sidechain/归因列（`is_sidechain`、`agent_type`、`skill`）与逐消息 token 列；`sessions` 获得了 `sidechain_count` 和存储的时长指标 `agent_active_ms` / `engaged_ms`；一个 FTS5 索引（`messages_fts`）支撑全局搜索；两个带版本号的 `contract_*` 视图为外部消费者提供只读的指标表面。这些全都遵循同样的幂等迁移模式——完整细节见[指标与契约视图](metrics-and-contract.md)。

**`messages`** 是归一化的事件流，在会话内按 `seq` 排序。`(session_id, seq)` 索引正是让窗口化回放变得廉价的原因——UI 只渲染选中位置周围约 400 行，因此按 `seq` 切片，而不是把 6,000 条消息的会话整个加载进 DOM。

## 归一化事件模型

每个解析器的职责就是把工具原生的日志转成同一种形状的扁平行列表。这种形状是摄取与所有下游功能之间的契约——回放、精修、因果、搜索和分享读取的都是同样的行。

**kind** 一览：

| `kind` | 含义 | 标签（`src/kinds.js`） |
| --- | --- | --- |
| `user` | 人类提示或插入的用户轮次 | User |
| `assistant` | 模型文字 | Assistant |
| `thinking` | 扩展思考块 | Thinking |
| `tool_use` | 一次工具调用（带 `tool_name`、`tool_input`、`tool_use_id`） | Tool Call |
| `tool_result` | 工具的输出（带 `tool_use_id`） | Tool Result |
| `note` | Refine 插入的批注 | Inserted |

每个事件行填充以下字段的一个子集：`ts`、`kind`、`text`、`tool_name`、`tool_input`（一个 JSON *字符串*，因此任意工具模式都能装进一列）、`tool_use_id`、`uuid`、`model`。`tool_use_id` 是连接键：一个 `tool_use` 与它产生的 `tool_result` 携带相同的 id，UI 正是靠它把调用与输出配对——即使二者之间隔着其他消息。

> **标签只有一个事实来源。** 每个 kind 的人类可读名称与图标只存在于 `src/kinds.js`（`KIND_LABEL` / `KIND_ICON`）。回放（`SessionView`）和精修（`RefineMode`）都从那里导入，因此词汇不会漂移——早期版本里回放说 "You"/"AI"，精修却说 "USER"/"ASSISTANT"。新的措辞放在那里，永远不要内联。

因为模型是归一化的，六款工具之间的差异被压缩为某个解析器填充哪些字段。一个 Cursor 工具调用与一个 Claude Code 工具调用抵达数据库时是同样的一行——各工具如何映射进来，见[解析器与摄取](parsers-and-ingestion.md)。

## `replaceSession()` — 幂等导入

导入不是逐行 upsert；它是**事务内对单个会话的完整删除并重插**。重新导入同一份日志会产生同样的行，因此 Sync Update 和重新导入可以放心地反复运行。

```js
// server/db.js — abridged
export function replaceSession(session, events) {
  db.exec('BEGIN');
  try {
    const prev = db.prepare('SELECT name FROM sessions WHERE id = ?').get(session.id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    db.prepare(`INSERT INTO sessions (..., name, summary, usage) VALUES (..., ?, ?, ?)`)
      .run(/* … */ session.name ?? prev?.name ?? null,
                   session.summary ?? null, session.usage ?? null);
    // reinsert every event with seq = its index
    events.forEach((e, i) => ins.run(session.id, i, /* … */));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
```

微妙之处在事务里的第一行。由于该行即将被删除，简单粗暴的重插会抹掉用户键入的任何重命名。因此 `replaceSession` **先读取 `prev.name` 并将其作为回退**（`session.name ?? prev?.name ?? null`）。结果是：

- **`name` 在重新导入后存活**——Chronicle 里的重命名是用户撰写的，绝不能被日志的重新解析覆盖。
- **`summary`、`usage`、`context_tokens` 每次导入都重新推导**——它们来自日志，因此最新的解析结果生效。

> **注意——过期构建会抹掉标题。** 一个早于 `name` 列、却共享同一个 `~/.chronicle/chronicle.db` 的旧打包应用不知道要保留它，会在任何同步时丢弃重命名。在调试"我的重命名消失了"之前，先退出游离的实例。

这也是导入顺序与幂等性能干净组合的唯一原因：整个会话是一次原子交换，导入中途崩溃会回滚，而不是留下半个会话。

## 相关内容
- [解析器与摄取](parsers-and-ingestion.md) — 每个工具的日志如何变成这些归一化行，外加新增来源的 HOWTO。
- [导入会话](../guide/importing-sessions.md) — 面向用户的导入向导与只读保证。
- [架构总览](overview.md) — 数据存储在整个系统中的位置。
