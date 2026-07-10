# 安全、实时流式、回放与因果关系

让 Chronicle 显得「聪明」的四个子系统——机密脱敏、实时会话 tail、确定性回放，以及读→改因果关系——全都是**本地启发式**。这套栈里任何地方都没有 LLM 调用，这恰恰是「默认离线」保证得以成立的原因。

本页面向贡献者，涵盖 `server/security.js`、`hooks/chronicle-guard.mjs`、`server/live.js`、`server/replay.js`、`server/causality.js` 与 `server/shares.js`。每一节都解释其数据流以及它所满足的设计约束。贯穿始终的一条线是：这里每一种「智能」行为都是你能读、能审计的模式匹配与结构分析，而不是一个你不得不去信任的模型。

## 安全引擎（`server/security.js`）

脱敏引擎把文本变成 `{ findings, redacted }`。它把一套固定的内置检测器与用户自定义的 glob 规则组合起来，按优先级解决重叠，且从不触碰原始数据——脱敏是单向的，且只施加于副本。

### 内置规则

`BUILTIN_RULES` 是一个有序的正则检测器数组，无需任何配置：

| 规则 id | 检测什么 | 脱敏示例 |
| --- | --- | --- |
| `api_key` | `sk-…`、`anthropic-…`、`AKIA…`、`ghp_…`、`xox…`、`AIza…` | `sk-****` |
| `password` | `password`/`secret` = 值 | 保留键，掩码值 |
| `token` | `Bearer …`、JWT（`eyJ…`） | `eyJ****` |
| `db_conn` | `postgres://`、`mysql://`、`mongodb://`、… | `****` |
| `email` | 电子邮件地址 | `***@***.com` |
| `phone` | 电话号码 | `***-***-****` |
| `private_ip` | `10.*`、`127.*`、`192.168.*`、`172.16–31.*` | `***.***.***.***` |

顺序很重要：`db_conn` 刻意在 `email`/`password` 之前运行，好让一个连接字符串被作为整体脱敏，而不是被撕成一个 email 匹配加一个 password 匹配（这就是「具体先于宽泛」的规则，被烘焙进了数组顺序里）。

### 自定义规则与优先级

自定义规则是 **glob**——`*` 匹配任意一串非空白字符，`?` 匹配单个字符——由 `globToRegex()` 编译成正则。一条规则要么是 `redact` 规则（`KITE-*`、`*@company.com`），要么是一条保护某段跨度免于脱敏的 `allow` 规则。`scanText()` 用一个固定的优先级来裁决所有争夺同一批字符的规则：

1. **allow 列表胜出。** 任何被 `allow` 规则匹配到的跨度会被优先保护，永远不会被脱敏。
2. **自定义 `redact` 规则先于内置规则。** 它们在规则集里被拼接到 `BUILTIN_RULES` 之前。
3. **重叠时更早的匹配胜出。** 一个 `claimed`（已占用）区间列表意味着，一旦一段跨度被脱敏，后来的规则就无法再占用重叠的字符。

结果是确定性的：findings 按位置排序，脱敏后的字符串通过把替换物拼接到那些已占用跨度之上来重建。导出：`listRules`、`addRule`、`deleteRule`、`toggleRule`、`scanText(text)`、`scanSession(messages)`、`preToolUseCheck(...)`、`listInterceptions`。

`scanSession(messages)` 是安全检查与分享创建所用的批量路径：它扫描每条消息的 `text` 和 `tool_input`，返回按消息的 findings 加上脱敏副本，并汇总一个 `totals` 直方图和 `findingCount`。

### 工具调用前（pre-tool-use）路径

`preToolUseCheck({ tool_name, tool_input }, readFileFn)` 是实时守卫的入口点。对于一个读取类工具（`Read`、`read_file`、`View`、`Grep`、`NotebookRead`），它通过注入的 `readFileFn` 扫描**文件的实际内容**；对于其他任何工具，它扫描序列化后的工具输入。只有高严重级别的规则才会拦截：

```js
const HIGH_SEVERITY = new Set(['api_key', 'password', 'token', 'db_conn']);
```

高严重级别的 findings（或任何自定义规则）返回 `decision: 'block'`，附带一个人类可读的原因；较低严重级别的匹配（email、phone、private IP）会被 `flagged` 但放行。无论哪种情形，该事件都会被写入 `interceptions` 表，于是它会出现在「安全 → 拦截」中。

### PreToolUse 钩子（`hooks/chronicle-guard.mjs`）

这个钩子是把 Chronicle 的引擎接进 Claude Code `PreToolUse` 事件的那层薄薄的 CLI 垫片。它从 stdin 读取钩子负载，把 `{tool_name, tool_input}` POST 给 `POST /api/security/pretooluse`，并依裁决行事：

```js
if (verdict.decision === 'block') {
  console.error(verdict.reason);   // stderr is shown to the model
  process.exit(2);                 // exit 2 = block the tool call
}
process.exit(0);                   // allow
```

两条设计保证让它可以安全安装：

- **失败即放行（Fails open）。** 一个 3 秒的 `fetch` 超时守着这次调用；如果 Chronicle 没在运行、报错，或超时，钩子就退出 `0`，工具调用原封不动地继续。一套在自己宕机时会拖垮你编辑器的安全工具，比没有工具更糟。
- **先备份。** 那个一键安装器（`POST /api/security/install-hook`）会在添加钩子之前备份 `~/.claude/settings.json`。它**默认不安装**——你要主动选择加入。该端点可通过 `CHRONICLE_URL` 覆盖。

> **贡献者陷阱——两处错误启发式，务必保持同步。** 「这条工具结果是不是一个错误？」这个检查存在于两个地方：`server/api.js` 里的 `ERROR_RE`（项目分析）和 `src/SessionView.jsx` 里的 `isErrorResult`（概览统计）。改了一处而不改另一处，两边的错误计数就会分道扬镳。如果你动了错误检测，请两处都动。

## 实时流式（`server/live.js`）

实时流式会 tail 一个进行中的会话，并通过 SSE 把新消息推送给打开着的查看器。`isLiveCandidate(filePath)` 用一个 **5 分钟新近度窗口**给它设门槛（文件在过去 5 分钟内被写过）；`attachLiveStream(sessionId, res)` 打开 SSE 流；`liveStatus()` 报告活跃的 watcher。

有两种 watcher 实现，按数据源选择：

| Watcher | 数据源 | 如何检测新内容 |
| --- | --- | --- |
| `Watcher`（JSONL tail） | Claude Code、Codex | `stat` 大小轮询 + 从上次偏移量增量读取；只解析新行 |
| `SqlitePollWatcher` | Cursor、OpenCode | 重新解析一个临时 DB **快照**，并与存下来的消息计数做差异；感知 WAL 的 mtime |

JSONL `Watcher` 从文件末尾开始（只有新内容才流出），为半写完的尾行保留一个 `partial` 缓冲区，并在文件被截断或轮转时从零重新读取。`SqlitePollWatcher` 从不实时打开外部 DB——解析器层会先把它快照到临时目录——并且它从 `max(db, db-wal)` 取 `mtime`，因为 WAL 写入可能不触及主文件。两者都会在约 2 分钟的静默后**放慢其轮询间隔**，并在最后一个查看器断开时**自动停止**（`removeClient` → `close`）。

有两个值得知道的实现事实：

- **Watcher 活在 `globalThis.__chronicleLive` 上**，好让一次 Vite SSR 模块重载不至于把轮询计时器变成孤儿。
- **实时消息使用从 1,000,000 起步的 `seq`**，以避免与存下来的序号相撞。它们只存在于客户端状态中，直到该会话被重新导入——实时 tail 是一种视图，而不是对 DB 的写入。

覆盖在这之上的 UI 层（`● LIVE` 指示器、指数退避重连、「N 条新消息」按钮）在 [实时流式](../guide/live-streaming.md) 中涵盖。

## 回放引擎（`server/replay.js`）

回放会在一个隔离的沙箱中重新执行一个会话的文件与 shell 操作，让你能看到代码*是如何*被构建出来的——确定性地，**没有任何 LLM 调用**，且从不触碰真实项目。

`REPLAY_ROOT = ~/.chronicle/replay`；每一次回放获得 `~/.chronicle/replay/<id>/`。

**计划。** `buildPlan(sessionId)` 遍历会话的消息，抽取出可执行的步骤——`Write`、`Edit` 和 `Bash` 工具调用——并把最近的 assistant/thinking 文本附加为该步骤的 `reasoning`。它会把目标路径逃逸出项目的步骤标记为 `outOfScope`。

**沙箱播种。** `startReplay(sessionId, workspace)` 抹掉并重建沙箱，然后从会话开始时的 Git 快照给它播种：它通过 [git 引擎](git-snapshot-engine.md) 的 `commitAt()` 找到 `session.started_at` 处的提交，并用 `git archive | tar -x` 把那棵树物化出来。因此回放起始于 AI 触碰它*之前*的代码——而不是当前磁盘。

**逐步执行。** `previewStep(sessionId, seq)` 计算即将到来的步骤相对当前沙箱状态的差异（对于一次 `Edit`，它甚至会报告那个 `old_string` 是否仍然 `applies`）。`executeStep(sessionId, seq, {confirmCommand})` 施加一个步骤：

- **Write / Edit** 直接施加到沙箱路径（一个绝对的项目路径会被重映射进沙箱；一个逃逸出去的路径会抛错）。
- **Bash** 需要显式的 `confirmCommand`——没有它，`executeStep` 会返回 `{ needsConfirmation: true }` 而不运行任何东西。命令以沙箱作为 `cwd` 和 `HOME`（软性收容）运行，带 60 秒超时，并捕获输出。

自动播放（1×/2×/5×）会**在出错时暂停**，并**跳过**命令步骤和项目外的写入——把它们标记为 `skipped` 而不是硬性暂停，好让这次运行不至于看起来卡住了。`openWorkspace()` 会在操作系统的文件浏览器中打开沙箱。真实项目在这个文件里的任何地方都不会是写入目标。见 [回放模式](../guide/replay-mode.md)。

## 上下文因果关系（`server/causality.js`）

`analyzeCausality(sessionId)` 把 AI **读过**的东西链接到它**改过**的东西，并给出一个启发式置信度分数——纯粹是对工具调用序列的结构分析，不涉及任何模型。它收集读取类工具调用（`Read`、`Grep`、`Glob`、…）与变更类工具调用（`Write`、`Edit`、…），然后针对每一次变更，给之前的每一次读取打分：

| 置信度 | 信号 |
| --- | --- |
| **0.95** | 读过它随后就改的那个确切文件 |
| 0.55 | 读过同一目录下的一个同级文件 |
| 0.5 | 读过一个同基名的文件 |
| 0.45 | 一个匹配到被改文件的搜索模式 |
| **0.2** | 在变更前不久有过读取（背景上下文，在一个 8 次读取的窗口内） |

来源按置信度排序，并按每次变更设上限。UI 里 Write/Edit 消息上的 `⛓` 徽章会打开一个这些来源引用的面板；置信度分级正是为什么一次同文件读取被高亮、而背景读取被淡化的原因。见 [上下文因果关系](../guide/context-causality.md)。

## 分享链接（`server/shares.js`）

分享是从**本地应用**把一个会话作为一个带令牌的 HTML 页面提供出来——没有任何东西被上传。关键性质是**脱敏在创建时被冻结**：

```js
createShare(sessionId, days = 7)   // → { token, url: `/share/${token}`, expires_at, redactions }
```

`createShare()` 对消息运行 `scanSession()`，并只把**脱敏后的副本**存进 `shares.content` 列。因为原文从不被持久化进分享，一次后来的规则变更——或某人读取那个 DB——都无法泄漏分享时被脱敏掉的内容。`listShares()` / `revokeShare(id)` 管理这些令牌（查看计数、即时撤销），而公开页面（`GET /share/:token`）一旦过期或被撤销就返回 `404`。默认生命周期是 7 天。

## 为什么全是启发式且本地

脱敏正则、实时 tail 轮询、回放对文件操作的重新执行，以及因果关系的结构打分，全都是贡献者能读、能推敲、能审计的东西——没有网络，没有推理，没有外部依赖。这正是重点所在：**一切重活都是启发式 + 本地的，所以 Chronicle 在拔掉网线时照样工作**，而它的「智能」是可检视的，而非不透明的。

## 相关

- [安全与分享](../guide/security-and-sharing.md) —— 安全检查、自定义规则、钩子、分享链接。
- [实时流式](../guide/live-streaming.md) —— LIVE 指示器与重连 UX。
- [回放模式](../guide/replay-mode.md) —— 确定性沙箱回放的演练。
- [上下文因果关系](../guide/context-causality.md) —— 读→改链接与置信度分级。
- [Git 快照引擎](git-snapshot-engine.md) —— 回放如何从历史给它的沙箱播种。
