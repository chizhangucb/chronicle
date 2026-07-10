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

- **用 `node:sqlite`，而非 better-sqlite3。** 它随 Node 一起发布，因此没有需要按平台编译或重建的原生模块——这是零工具链构建的硬性要求。用 `CHRONICLE_DATA_DIR` 覆盖数据目录（在测试和一次性实例时很方便）。
- **Schema 在模块加载时幂等地创建。** 每次模块加载，`db.exec()` 都会运行完整的 `CREATE TABLE IF NOT EXISTS …` 代码块，而 schema 变更以尽力而为的迁移方式应用：

```js
// Idempotent migrations — safe to run on every boot
try { db.exec('ALTER TABLE sessions ADD COLUMN context_tokens INTEGER'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN name TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT'); } catch {}
try { db.exec('ALTER TABLE sessions ADD COLUMN usage TEXT'); } catch {}
```

这里没有迁移框架，也没有版本表。加一个新列就是一行 `try { ALTER TABLE … } catch {}`：升级后的首次启动会添加它，之后每一次启动都在 `catch` 里无操作。这样就够了，因为 schema 很小且只增不减，同时保住了「拿来即跑」的特性——不会有一个单独的迁移步骤让你忘记执行。

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

**`projects`** 以 `path` 为键——即日志里记录的物理 `cwd`（当工具未记录 cwd 时，则用虚拟路径 `gemini-project:<hash>`）。无论多少款工具在同一个物理目录里干过活，它都是一个逻辑项目。`upsertProject(physicalPath)` 在唯一的 `path` 上执行插入或忽略，并返回该行。

**`sessions`** 承载身份与摘要字段。基础列是最初的 schema；那四个**迁移列**是后来加的，这恰恰是它们为什么是 `ALTER TABLE` 而非 `CREATE` 一部分的原因：

| 列 | 来源 | 为何是迁移列 |
| --- | --- | --- |
| `context_tokens` | 最后一次主链 API 调用的提示侧 | 上下文窗口条形图上线时加入；**仅在导入时设置**——升级后需重新导入或 Sync Update 来回填 |
| `name` | 用户在 Chronicle 里手动键入的重命名 | 内联重命名功能上线时加入；表中唯一由用户撰写的字段 |
| `summary` | 解析出的工具标题（Claude Code 的 `custom-title`，以最后一个为准） | 自动标题功能上线时加入；每次导入重新推导 |
| `usage` | 以 JSON 表示的按模型 token 总量 | 成本与用量面板上线时加入；每次导入重新推导 |

`usage` 这段 JSON 的形状是 `{model: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}}`——5 分钟和 1 小时的缓存写入分开保存，因为它们的计费费率不同（见 [会话洞察](../guide/session-insights.md)）。

**`messages`** 是归一化的事件流，在一个会话内按 `seq` 排序。`(session_id, seq)` 索引正是让窗口化回放变得廉价的原因——UI 只渲染选中位置周围约 400 行，因此它按 `seq` 切片，而不会把一个 6000 条消息的会话整个加载进 DOM。

## 归一化事件模型

每个解析器的任务，就是把一份工具原生的日志变成一列形状统一的扁平行。这个形状是摄取与下游一切之间的契约——回放、精修、因果关系、搜索和分享读取的都是同一批行。

**各种 kind**：

| `kind` | 含义 | 标签（`src/kinds.js`） |
| --- | --- | --- |
| `user` | 一次人类提示，或一次插入的用户回合 | User |
| `assistant` | 模型的散文输出 | Assistant |
| `thinking` | 扩展思考块 | Thinking |
| `tool_use` | 一次工具调用（带有 `tool_name`、`tool_input`、`tool_use_id`） | Tool Call |
| `tool_result` | 一次工具的输出（带有 `tool_use_id`） | Tool Result |
| `note` | 一条 Refine 插入的批注 | Inserted |

每个事件行填充下列字段的一个子集：`ts`、`kind`、`text`、`tool_name`、`tool_input`（一个 JSON *字符串*，因此任意工具 schema 都能塞进一列）、`tool_use_id`、`uuid`、`model`。`tool_use_id` 是连接键：一次 `tool_use` 与它产生的 `tool_result` 携带相同的 id，这正是 UI 即便在两者之间夹着别的消息时，也能把一次调用与它的输出配对起来的方式。

> **标签的唯一真相来源。** 每个 kind 的人类可读名称与图标只存在于 `src/kinds.js`（`KIND_LABEL` / `KIND_ICON`）。回放（`SessionView`）与精修（`RefineMode`）都从那里导入，因此词汇不会漂移——更早的版本里回放说的是「You」/「AI」，而精修说的是「USER」/「ASSISTANT」。新措辞放到那里，绝不要内联写死。

因为模型是归一化的，六款工具之间的差异便坍缩为「某个特定解析器填充了哪些字段」。当一次 Cursor 工具调用和一次 Claude Code 工具调用抵达数据库时，它们已是同一种行——各款工具如何映射进来，见 [解析器与摄取](parsers-and-ingestion.md)。

## `replaceSession()` —— 幂等导入

导入不是逐行 upsert；它是在一个事务内对单个会话执行完整的**删除并重新插入**。重新导入同一份日志会产生完全相同的行，因此 Sync Update 与重新导入可以反复安全运行。

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

微妙之处在事务内的第一行。因为这一行马上就要被删除，一次天真的重新插入会抹掉用户键入的任何重命名。所以 `replaceSession` **先读取 `prev.name` 并以它作为兜底**（`session.name ?? prev?.name ?? null`）。结果是：

- **`name` 在重新导入后依然存活**——一次 Chronicle 重命名是由用户撰写的，绝不能被重新解析日志所覆盖。
- **`summary`、`usage`、`context_tokens` 每次导入都重新推导**——它们来自日志，所以以最新的一次解析为准。

> **注意——一个过期的构建可能抹掉标题。** 一个早于 `name` 列、却共享同一个 `~/.chronicle/chronicle.db` 的旧打包应用并不知道要保留它，会在任何一次同步时丢掉重命名。在排查「我的重命名不见了」这类报告之前，请先退出那些游离的实例。

这也是导入顺序与幂等性能够干净组合的唯一原因：整个会话是一次原子交换，因此一次导入中途崩溃会回滚，而不会留下半个会话。

## 相关

- [解析器与摄取](parsers-and-ingestion.md) —— 每款工具的日志如何变成这些归一化的行，外加一份添加数据源的 HOWTO。
- [导入会话](../guide/importing-sessions.md) —— 面向用户的导入向导与只读保证。
- [架构总览](overview.md) —— 数据存储在整个系统中的位置。
