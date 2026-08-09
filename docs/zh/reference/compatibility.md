# 兼容性

Chronicle 支持哪些 AI 编程工具、每项功能在各工具下的表现，以及每个工具的日志在磁盘上的位置。

Chronicle 从六款工具导入对话日志，并将每条消息映射到当时的 Git 快照。大多数功能在这六款工具上表现完全一致；子代理（sidechain）归因是 Claude Code 特有的，而远程访问尚未构建。下文所述均反映 v0.2.0 的发布内容——如果你需要更深入了解，可对照阅读源码 `server/parsers/<tool>.js`。

## 功能支持矩阵

| 功能 | Claude Code | Codex | Cursor | OpenCode | Gemini CLI | Copilot Chat |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| 对话导入 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 时间旅行 / 代码快照 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 回放模式 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 消息过滤 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 内容脱敏 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工具调用查看 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| 上下文因果 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Git 历史匹配 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 实时流式 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 自动同步 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sidechain（子代理）导入 | ✅ | – | – | – | – | – |
| 逐消息 token 用量 | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| 远程 SSH 访问 | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 |

图例：✅ 完整 · ⚠️ 部分 · 🔜 计划中（尚未构建） · – 不适用。

- **工具调用查看**对 Gemini CLI 而言是部分支持——与基于 JSONL 的工具相比，它的日志对工具活动的记录不够完整。
- **Sidechain（子代理）导入**——带有 `agent_type` 与 `skill` 归因——是 Claude Code 的概念；其他解析器会将每一行标记为 `is_sidechain = 0`。
- **逐消息 token 用量**在工具日志携带用量记录之处均会被捕获；覆盖程度因工具和日志版本而异。见[指标与契约视图](../architecture/metrics-and-contract.md)。
- **远程 SSH 访问**（通过 SSH 导入 / 浏览 / 实时监视）对所有工具都是**已列入计划但尚未实现**。Chronicle 今天所做的一切都针对本地文件运行。

## 日志位置

每个解析器从其工具的知名路径读取原生日志。Chronicle 从不写入这些路径——见只读一列。

| 工具 | 来源键 | 路径 | 格式 | 只读处理方式 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `~/.claude/projects/` | JSONL | 就地读取；原始文件从不被修改 |
| Codex | `codex` | `~/.codex/sessions/` | JSONL | 就地读取；原始文件从不被修改 |
| Cursor | `cursor` | VS Code `workspaceStorage` 状态数据库（可用 `CHRONICLE_CURSOR_DIR` 覆盖） | SQLite（WAL） | 打开前复制到临时位置，**包括 `-wal`/`-shm`** |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` | SQLite（WAL） | 打开前复制到临时位置，**包括 `-wal`/`-shm`** |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/` | JSON | 就地读取；原始文件从不被修改 |
| Copilot Chat | `copilot-chat` | VS Code `workspaceStorage/<hash>/chatSessions/`（可用 `CHRONICLE_VSCODE_DIR` 覆盖） | JSON | 就地读取；原始文件从不被修改 |

> **永远只读：** 基于 SQLite 的来源（Cursor、OpenCode）是 WAL 数据库。只复制 `.db` 文件会得到一个*空*数据库——最近的写入位于 `-wal` 附属文件中——因此解析器会把 `-wal` 和 `-shm` 文件一并复制到临时位置并打开副本。你的工具的实时数据库从不被触碰。

默认路径常量位于各解析器中（`server/parsers/*.js` 里的 `CLAUDE_PROJECTS_DIR`、`CODEX_SESSIONS_DIR`、`OPENCODE_DB`、`GEMINI_TMP`）。只有 Cursor 和 Copilot 提供环境变量覆盖——见[配置](./configuration.md)。

### 各工具注意事项

- **Gemini CLI 不记录工作目录。** 由于日志中没有 `cwd`，Chronicle 会分配一个虚拟路径（`gemini-project:<hash>`）并显示 **"Needs association"** 横幅。将其指向真实项目一次，Chronicle 便会按路径匹配合并这些会话。
- **Copilot Chat 横跨多个 VS Code 发行版。** 扫描器会查看 VS Code **stable、Insiders 和 VSCodium** 的 `workspaceStorage`，因此来自其中任意安装的 Copilot 会话都会被发现。
- **Cursor 和 OpenCode 的多个会话共享同一个数据库。** 由于一个文件支撑多个会话，这些工具的按会话源文件删除被禁用（仅对一文件一会话的来源提供：Claude Code、Codex、Copilot）。

## 已知限制

- **大型会话会优雅降级。** 超过约 5,000 条消息后，UI 切换为窗口化渲染——只在你当前位置周围绘制约 400 行 DOM，并抽稀时间轴刻度——因此一个 6,000 条消息的会话仍能保持流畅。你通过搜索和时间轴导航，而不是无边界的滚动。
- **Git 子模块**受快照引擎支持。
- **非标准或自定义日志路径**通过手动选择处理：使用导入向导的 Browse 选项（或 `CHRONICLE_CURSOR_DIR` / `CHRONICLE_VSCODE_DIR` 覆盖）将 Chronicle 指向默认位置之外的日志。

## 相关内容

- [导入会话](../guide/importing-sessions.md) — 导入向导与各来源的只读保证。
- [解析器与摄取](../architecture/parsers-and-ingestion.md) — 归一化事件模型，以及如何添加第七个来源。
