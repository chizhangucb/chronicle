# 兼容性

Chronicle 支持哪些 AI 编程工具、每项功能在各工具下的表现，以及每个工具的日志在磁盘上的位置。

Chronicle 从六款工具导入对话日志，并将每条消息映射到当时的 Git 快照。大多数功能在这六款工具上表现完全一致；少数控制面功能（MCP Hub、Skills Hub）仅适用于保留相应配置的工具，而远程访问尚未构建。下文所述均反映 v0.1.7 的发布内容——如果你需要更深入了解，可对照阅读源码 `server/parsers/<tool>.js`。

## 功能支持矩阵

| 功能 | Claude Code | Codex | Cursor | OpenCode | Gemini CLI | Copilot Chat |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| 对话导入 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 时间旅行 / 代码快照 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Replay 模式 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 消息过滤 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 内容脱敏 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工具调用查看 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| 上下文因果关系 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Git 历史匹配 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 实时流式传输 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP Hub 接管 | ✅ | ✅ | ✅ | – | ✅ | – |
| Skills Hub 接管 | ✅ | ✅ | ✅ | – | ✅ | – |
| 远程 SSH 访问 | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 |

图例：✅ 完整 · ⚠️ 部分 · 🔜 计划中（尚未构建） · – 不适用。

- **工具调用查看**对 Gemini CLI 仅为部分支持——其日志对工具活动的记录不如基于 JSONL 的工具那样完整。
- **MCP / Skills Hub 接管**适用于那些保留了 Chronicle 可扫描并集中管理的、可发现的 MCP/skills 配置的工具：Claude Code、Codex、Cursor 和 Gemini CLI。OpenCode 和 Copilot Chat 没有此类可接管的配置。
- **远程 SSH 访问**（通过 SSH 进行导入 / 浏览 / 实时监视）对所有工具都是**计划中但尚未实现**。Chronicle 今天所做的一切都在本地文件上运行。

## 日志位置

每个解析器都从其工具的一个众所周知的路径读取原生日志。Chronicle 从不写入这些日志——参见“只读处理”一列。

| 工具 | 源键 | 路径 | 格式 | 只读处理 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/` | JSONL | 就地读取；原始文件从不被修改 |
| Codex | `codex` | `~/.codex/sessions/` | JSONL | 就地读取；原始文件从不被修改 |
| Cursor | `cursor` | VS Code `workspaceStorage` state 数据库（`CHRONICLE_CURSOR_DIR` 可覆盖） | SQLite (WAL) | 打开前连同 `-wal`/`-shm` **一起**复制到临时目录 |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` | SQLite (WAL) | 打开前连同 `-wal`/`-shm` **一起**复制到临时目录 |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/` | JSON | 就地读取；原始文件从不被修改 |
| Copilot Chat | `copilot-chat` | VS Code `workspaceStorage/<hash>/chatSessions/`（`CHRONICLE_VSCODE_DIR` 可覆盖） | JSON | 就地读取；原始文件从不被修改 |

> **始终只读：** 由 SQLite 支撑的源（Cursor、OpenCode）是 WAL 数据库。仅复制 `.db` 文件会得到一个*空*数据库——最近的写入位于 `-wal` 附属文件中——因此解析器会将 `-wal` 和 `-shm` 文件复制到临时位置并打开该副本。你的工具的活动数据库绝不会被触碰。

默认路径常量存在于每个解析器中（`server/parsers/*.js` 中的 `CLAUDE_PROJECTS_DIR`、`CODEX_SESSIONS_DIR`、`OPENCODE_DB`、`GEMINI_TMP`）。只有 Cursor 和 Copilot 提供了环境变量覆盖——参见[配置](./configuration.md)。

### 各工具的注意事项

- **Gemini CLI 不记录工作目录。** 由于日志中没有 `cwd`，Chronicle 会分配一个虚拟路径（`gemini-project:<hash>`）并显示一个 **“需要关联”**横幅。将它指向真实项目一次，Chronicle 便会依据路径匹配合并这些会话。
- **Copilot Chat 跨越多个 VS Code 发行版。** 扫描器会在 VS Code **stable、Insiders 和 VSCodium** 的 `workspaceStorage` 中查找，因此来自其中任一安装的 Copilot 会话都会被识别。
- **Cursor 和 OpenCode 在多个会话间共享同一个数据库。** 由于一个文件支撑着多个会话，这两款工具的按会话源文件删除功能被禁用（该功能仅对一个文件对应一个会话的源提供：Claude Code、Codex、Copilot）。

## 已知限制

- **大型会话会优雅降级。** 超过约 5,000 条消息后，UI 会切换到窗口化渲染——它在你当前位置周围绘制大约 400 个 DOM 行，并对时间轴刻度进行抽稀——因此一个 6,000 条消息的会话仍然保持流畅。你通过搜索和时间轴而非无边界滚动来导航。
- **Git 子模块**受快照引擎支持。
- **非标准或自定义日志路径**通过手动选择处理：使用导入向导的 Browse 选项（或 `CHRONICLE_CURSOR_DIR` / `CHRONICLE_VSCODE_DIR` 覆盖），将 Chronicle 指向默认位置之外的日志。

## 相关内容

- [导入会话](../guide/importing-sessions.md) — 导入向导以及各源的只读保证。
- [解析器与摄取](../architecture/parsers-and-ingestion.md) — 归一化的事件模型，以及如何添加第七个源。
