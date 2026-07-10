# 导入会话

这个四步导入向导把六种 AI 编程工具的对话日志拉入 Chronicle 的本地数据库——只读、逐个会话、重复运行时幂等。

导入是 Chronicle 与你现有工具相遇的地方。它从不要求你改变工作流：它读取你的 AI 助手已经写入其标准位置的
日志，将它们规范化为同一个事件模型，并存入位于 `~/.chronicle/chronicle.db` 的本地 SQLite 数据库。你的
原始日志绝不会被修改——这一保证即便对由 SQLite 支持的工具也成立。

## 导入向导

在主屏幕上用 **+ Import Sessions** 打开它。向导是一个四步流程，以顶部的步骤条形式呈现：

**1. 选择来源 (Select Source)。** Chronicle 会扫描每种工具的标准日志目录，并只显示它确实找到的来源，
每个来源附带一个会话计数。如果什么都没找到，你会看到 “No local AI tool logs found”。

**2. 选择文件 (Select Files)。** 这是最主要的一步。项目会连同其物理路径一起列出；在 Chronicle 能够
枚举单个会话的地方，每个项目会展开为一份会话清单。每个项目（和会话）都带有一个徽章：

- **NEW** —— 从未导入。
- **Partial N/M** —— 项目的部分会话已经导入。
- **Imported** —— 已完全导入。

一旦你选择了来源，新会话就会被**自动选中**，因此最常见的情形（导入所有新内容）只需一次点击。你还会得到：

- 一个**搜索**框，可按名称、路径或 id 筛选项目*和*会话；
- **Rescan**，无需离开向导即可重新扫描来源（它会保留你当前的选择，并自动选中任何新出现的 NEW 会话）；
- **Select Directory Manually**，把 Chronicle 指向任意一个绝对日志目录——对于位于非标准位置的日志很有用；
- 页脚操作 **Select All New**、**Clear** 和 **Invert**。

汇总条会持续统计项目数、会话数，以及其中已经导入的数量。

**3. 导入中 (Importing)。** 每个含有已选会话的项目会运行一个导入任务，带有进度条和按项目的状态
（pending → importing → done/failed）。

**4. 完成 (Complete)。** 一份关于已导入会话、新建 vs. 更新的项目，以及任何失败的汇总。导入后的消息数会
*低于*扫描时的原始条目估算——子代理的闲聊、系统提醒和命令回显都被当作噪声过滤掉了（更多内容见
[解析器与摄取](../architecture/parsers-and-ingestion.md)）。点击 **Import more** 返回重来，或点 **Done**。

## 六种来源及其所在位置

Chronicle 从每种工具的标准位置读取。如果你的设置非标准，每个位置都可用一个环境变量（括号中）覆盖——参见
[配置](../reference/configuration.md)。

| 工具 | 日志位置 | 格式 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/` (`CLAUDE_PROJECTS_DIR`) | JSONL |
| Codex | `~/.codex/sessions/` (`CODEX_SESSIONS_DIR`) | JSONL |
| Cursor | workspaceStorage (`CHRONICLE_CURSOR_DIR`) | SQLite |
| OpenCode | `~/.local/share/opencode/opencode.db` (`OPENCODE_DB`) | SQLite |
| Gemini CLI | `~/.gemini/tmp/` (`GEMINI_TMP`) | JSON |
| Copilot Chat | VS Code `workspaceStorage/<hash>/chatSessions/` (`CHRONICLE_VSCODE_DIR`) | JSON |

完整的各工具能力矩阵——哪些受支持、哪些是部分支持，以及每种格式的怪癖——见
[兼容性](../reference/compatibility.md)。

## 始终只读

Chronicle 把外部数据视为不可触碰：

- **JSONL 与 JSON 来源**被直接读取，绝不写入。
- **SQLite 来源（Cursor、OpenCode）**在 Chronicle 打开之前会被复制到一个临时位置——**连同 `-wal` 和
  `-shm` 文件**。这一点很重要：只复制 `.db` 文件会得到一个空数据库，因为尚未 checkpoint 的写入还留在
  WAL 里。Chronicle 从不打开处于运行中的数据库。

你导入的一切都落入 Chronicle 自己位于 `~/.chronicle/chronicle.db` 的数据库。从 Chronicle 删除一个项目
或会话只会把它从*那个*数据库移除；你的源日志原封不动，随时可以重新导入。

> **本地优先：** 导入是一次单向读取。导入、查看或分享一个会话，都绝不会修改你的任何日志、配置或仓库。

## 重新导入是安全的

重新导入一个会话是**幂等的**。在底层，`server/db.js` 中的 `replaceSession()` 在单个事务中删除旧行并
重新插入，因此你永远不会得到重复项。有两点值得了解：

- **Chronicle 中的重命名会在重新导入后保留。** 如果你在 Chronicle 内部重命名过一个会话，那个用户设定的
  名称会在删除并重新插入的过程中被读回并保留。（诸如工具摘要、token 用量和上下文大小等解析出来的字段，
  *确实*会在每次导入时重新推导。）
- **`context_tokens` 仅在导入时填充。** 真实的上下文窗口用量是在会话导入时捕获的。如果你升级了
  Chronicle，请重新导入或使用 **Sync Update** 来回填它；否则卡片会退回到 `~chars/4` 的估算。

你可以从向导、从项目的 **Sync Update** 菜单，或用同步按钮（`⇧⌘U`）按会话重新导入。各种同步入口参见
[项目管理](./project-management.md)。

## Gemini 与“需要关联 (Needs association)”

Gemini CLI 不会在它的日志里记录真实的项目路径。Chronicle 无法像对其他工具那样把这些会话关联到某个代码
文件夹，所以它们在导入时会落到一个虚拟路径下（`gemini-project:<hash>`），项目页面会显示一个
**“Needs association”** 横幅。把它指向实际的代码文件夹，Chronicle 就会将这些会话合并到匹配的项目里——
之后时间旅行便可正常工作，因为 Git 历史就在代码所在之处。这一点在
[项目管理](./project-management.md) 中有进一步说明。

## 相关内容

- [兼容性](../reference/compatibility.md) —— 完整的六工具支持矩阵与日志位置细节。
- [解析器与摄取](../architecture/parsers-and-ingestion.md) —— 规范化事件模型，以及如何添加一个新来源。
- [项目管理](./project-management.md) —— 逻辑项目、关联、同步，以及 Git 药丸标签。
