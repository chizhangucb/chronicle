# 解析器与摄取

摄取把六款不同工具的原生日志变成一条归一化的事件流。它分两个阶段运行——**扫描**（列出有哪些可导入的内容）和**导入**（解析所选日志并写入）——并且它从不写入源日志或项目仓库。

本页解释「扫描 → 导入」的流水线、每个解析器所隐藏的各款工具特有的怪癖（SQLite WAL 复制、cwd 解析、Claude Code 的噪声过滤），以及添加第七个数据源的具体演练。如果你想了解这些解析器发出的行形状，请先读 [数据模型](data-model.md)。

## 流水线：先扫描，再导入

每个解析器都位于 `server/parsers/<tool>.js`，并导出同样两类函数：

- **`scan<Tool>Projects()`** —— 廉价、只读。它列出可导入的项目及其会话，并附带体量估算，但不解析消息正文。这是导入向导渲染所依据的东西。
- **一个解析函数** —— 读取一个会话的原生日志，返回 `{ session, events }`，其中 `events` 就是 [数据模型](data-model.md) 中所述的归一化行。

今天已接入的六个解析器：

| 工具 | 数据源键 | 文件 / 目录（环境变量覆盖） | 格式 | 扫描 / 解析导出 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/`（`CLAUDE_PROJECTS_DIR`） | JSONL | `scanClaudeProjects()`、`parseClaudeSession()`（+ `parseClaudeLine()`） |
| Codex | `codex` | `~/.codex/sessions/`（`CODEX_SESSIONS_DIR`） | JSONL | `scanCodexProjects()`、`parseCodexSession()` |
| Cursor | `cursor` | workspaceStorage（`cursorUserDir()`、`CHRONICLE_CURSOR_DIR`） | SQLite | `scanCursorProjects()`、`parseCursorWorkspace()` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db`（`OPENCODE_DB`） | SQLite | `scanOpencodeProjects()`、`parseOpencodeSessions()` |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/`（`GEMINI_TMP`） | JSON | `scanGeminiProjects()`、`parseGeminiProject()` |
| Copilot Chat | `copilot-chat` | VS Code `workspaceStorage/<hash>/chatSessions/`（`vscodeUserDirs()`、`CHRONICLE_VSCODE_DIR`） | JSON | `scanCopilotProjects()`、`parseCopilotWorkspace()` |

`server/api.js` 向全部六者扇出。`GET /api/scan` 调用每一个 `scan…Projects()`，并标注哪些项目/会话已被导入；`POST /api/import` 把所选数据源通过 `gatherParsed()` 路由到正确的解析函数，然后把每个 `{ session, events }` 交给 `replaceSession()`：

```js
// server/api.js — scan fans out to every source
api.get('/scan', (req, res) => {
  res.json({
    'claude-code': annotateScan(scanClaudeProjects()),
    codex:         annotateScan(scanCodexProjects()),
    cursor:        annotateScan(scanCursorProjects()),
    opencode:      annotateScan(scanOpencodeProjects()),
    'gemini-cli':  annotateScan(scanGeminiProjects()),
    'copilot-chat':annotateScan(scanCopilotProjects()),
  });
});
```

同一个 `scanners` 映射也支撑着手动的「选择目录」扫描（传入 `?source=&dir=`），并且 `POST /api/projects/:id/sync` 会复用它，来重新导入映射到某个项目路径的每一处源位置。

> **始终只读。** 扫描与导入只读取源日志。摄取的写入侧除了 Chronicle 自己的 `~/.chronicle/chronicle.db` 之外什么都不碰。

## 各款工具的注意事项

归一化模型隐藏了工具之间的真实差异。有意思的工程都在解析器里。

### Claude Code JSONL —— 过滤噪声

`server/parsers/claudeCode.js` 里的 `parseClaudeLine()` 刻意挑剔，因为原样导入会塞满机器自言自语的内容：

- **跳过 `isSidechain` 条目。** 子智能体的回合属于一个独立的上下文；把它们包含进来会污染主线程。
- **跳过 `<command-name>` / `<local-command…>` 用户字符串** —— 这些是斜杠命令的脚手架，不是真正的提示。
- **跳过 `<system-reminder>` 文本块** —— 这些是注入的上下文，不是对话。
- **`tool_use` / `tool_result` 按 id 配对。** 一个 `tool_result` 块携带 `tool_use_id`，与发起该调用的 `tool_use` 相匹配。

会话的自动标题来自 `{"type":"custom-title","customTitle":…}` 行——即 `/rename` 标题，并且**以最后一个为准**（一个会话可以被反复重命名）。它会成为 `sessions.summary`。真实日志里实际上没有 `type:"summary"` 行，因此 `custom-title` 是唯一的自动标题来源（旧式的 `summary` 行仅作为兜底保留）。同一次解析过程还会聚合按模型的 token 用量，以及来自 `message.usage` 的真实 `context_tokens`。

### Cursor 与 OpenCode —— 复制 WAL，绝不实时打开

两者都把聊天存进运行中的编辑器可能仍在写入的 SQLite 数据库。Chronicle 会把该数据库复制到一个临时目录——**连同 `-wal` 和 `-shm` 附属文件一起**——然后只读打开：

```js
// server/parsers/opencode.js — copy sidecars or you get an EMPTY database
fs.copyFileSync(dbPath, copy);
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
}
```

这样规避的微妙 bug 是：在 WAL 模式下，最新的写入活在 `-wal` 文件里，而不在 `.db` 里。只复制 `.db`，你打开的就是一个缺失了近期（有时是全部）行的快照。复制附属文件则能给出一份一致的时间点读取，而完全无需触碰——或锁定——那个实时数据库。

### Gemini CLI —— 虚拟路径与「需要关联」

Gemini 的日志不记录工作目录，因此没有物理 `cwd` 可用作项目键。`scanGeminiProjects()` 会分配一个虚拟路径 `gemini-project:<hash>`，并把该项目标记为 `needsAssociation: true`。UI 会呈现一个**「需要关联」**横幅；关联它（`POST /api/projects/:id/associate`）会在路径匹配时把虚拟项目并入真实项目，于是它的会话就与同一目录下其他工具的工作并列在一起。

### cwd 解析 —— 最新的胜出，向上坍缩到祖先目录

逻辑项目以日志里的物理 `cwd` 为键，但单个会话可能记录了好几个。两条规则来调和它们：

- **最新的 `cwd` 胜出。** 一个在仓库移动后被恢复的会话，会在其早期记录里保留*旧*路径；最新的 cwd 才是仓库（及其 Git 历史）如今所在之处。扫描器会嗅探每个 JSONL 文件的**头部和尾部各 64 KB**来廉价地找到它，而解析器则跟踪最后一次见到的 cwd。
- **`reduceCwd()` 坍缩子目录。** 如果一个会话既记录了 `<repo>/server`，又记录了 `<repo>`，分组时应落在仓库根。`reduceCwd(pick, seen)` 会向上走到最短的、已见过的祖先，好让一个项目的所有会话归到一起。

## HOWTO：添加一个新数据源

添加第七款工具是一次自包含、分四步的变更。假设你要添加一款名为 `newtool` 的工具。

**1. 编写 `server/parsers/newtool.js`。** 导出两个函数：

```js
// scan<Tool>Projects() — cheap listing for the import wizard
export function scanNewtoolProjects(baseDir = NEWTOOL_DIR) {
  // return [{ source: 'newtool', name, physicalPath, sessionCount,
  //           messageEstimate, sessions: [{ id, file, label, modifiedAt, messageEstimate }] }]
}

// parse fn → { session, events } where each event is a normalized row:
//   { ts, kind, text?, tool_name?, tool_input?, tool_use_id?, uuid?, model? }
// kind ∈ user | assistant | thinking | tool_use | tool_result
export async function parseNewtoolSession(file) {
  return {
    session: { id, source: 'newtool', file_path: file, cwd,
               started_at, ended_at, first_prompt, summary, context_tokens, usage },
    events,
  };
}
```

在 session 上填好 `cwd`，让它键到一个物理项目（或者像 Gemini 那样返回一个虚拟的 `newtool-project:<hash>` 路径并设置 `needsAssociation`）。如果你的数据源是一个 WAL 型 SQLite 数据库，请像 Cursor/OpenCode 那样，把 `-wal`/`-shm` 附属文件原样复制到临时目录——绝不要打开实时文件。

**2. 把它接入 `server/api.js`。** 导入这两个函数，把 `newtool` 加进 `scanners` 映射和 `GET /scan` 的响应，并在 `gatherParsed()` 里加一个分支，让 `POST /import` 路由到你的解析函数。（把它加进 `sync` 和按会话的同步映射，就能免费获得 Sync Update。）

**3. 把它加进 `src/ImportWizard.jsx` 里的 `SOURCES`**，让它作为一个磁贴出现在向导里：

```js
{ key: 'newtool', label: 'New Tool', hint: '~/.newtool/…', icon: '◆' }
```

`key` 必须与你在 `/api/scan` 里用的数据源键匹配。

**4. 先对着 fixture 验证，再对着真实数据验证。** 往 `test/fixtures/` 里放一份小样本日志（该仓库已有 `codex-sessions/`、`cursor-user/`、`gemini-tmp/`、`oc-live.db`、`vscode-user/`），确认扫描能列出它、导入能产出合理的归一化行。然后端到端跑一遍：导入一个真实会话，打开它，并在其中做时间旅行。最快的完整检查就是导入 Chronicle 自己的 Claude Code 会话并四处点点看。

这就是全部的接触面。因为每种模式服务的都是相同的 Express 应用，一个接入了 `/api/scan` 和 `/api/import` 的解析器，无需任何额外的管线，就能在 dev、desktop 和 standalone 中生效。

## 相关

- [数据模型](data-model.md) —— 你的解析器必须发出的归一化事件行与 `kind` 标签。
- [兼容性](../reference/compatibility.md) —— 完整的六工具矩阵与日志位置。
- [贡献指南](../contributing.md) —— 环境搭建、工作流与验证习惯。
