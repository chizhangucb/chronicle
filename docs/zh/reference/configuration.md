# 配置

Chronicle 将数据保存在何处、它读取哪些环境变量，以及你可以覆盖的少数几项设置。

Chronicle 几乎不需要配置——它开箱即用，直接对接你的工具的默认日志位置，并将一切存储在你主目录下的单一目录中。本页记录该目录、应用各部分读取的环境变量、可选的 `config.json`，以及端口。这里没有设置服务器，也没有账户；覆盖只通过文件和环境变量完成。

## `~/.chronicle/` 目录

Chronicle 写入的一切都位于一个基础目录下（默认为 `~/.chronicle`；参见下文的 `CHRONICLE_DATA_DIR`）。它在首次运行时被幂等地创建。

| 路径 | 存放内容 |
| --- | --- |
| `chronicle.db` | SQLite 数据库——所有项目、会话和消息。通过 `node:sqlite`（`DatabaseSync`）打开，无需原生编译 |
| `skills/` | 中央 Skills Hub 存储（`CENTRAL_SKILLS`），以符号链接分发到每个工具的 skills 目录 |
| `snapshots/` | Skill 版本历史（导入快照 + 经防抖处理的文件系统变更快照） |
| `backups/mcp/` | 一键接管前所做的 MCP 配置备份（源配置从不被就地重写） |
| `replay/<id>/` | 各次运行的 Replay 沙箱，以会话开始时的 Git 快照为种子创建 |
| `feedback.log` | 每一次反馈提交，均在任何网络发送*之前*先在本地追加 |
| `config.json` | 可选的用户覆盖（见下文） |

> **注意：** `backups/` 也是其他破坏性或用户可见操作（hook 安装、恢复）先行备份的位置——在更改任何你可能会遗漏的内容之前，Chronicle 总是先写入一份备份。

## 环境变量

每个变量都由某个特定文件读取，见最后一列。未设置的变量将回退到所示的默认值。

| 变量 | 默认值 | 用途 | 读取方 |
| --- | --- | --- | --- |
| `CHRONICLE_DATA_DIR` | `~/.chronicle` | 数据库及上述所有状态的基础目录 | `server/db.js`（DB 路径）与 `server/api.js`（反馈日志、`config.json`） |
| `CHRONICLE_FEEDBACK_RELAY` | `relay.getchronicle.dev` | 覆盖托管的反馈中继 URL | `server/api.js` |
| `CHRONICLE_CURSOR_DIR` | Cursor 的 VS Code `workspaceStorage` | 将 Cursor 解析器指向非标准位置 | `server/parsers/cursor.js` |
| `CHRONICLE_VSCODE_DIR` | VS Code / Insiders / VSCodium 用户目录 | 将 Copilot Chat 解析器指向非标准的 VS Code 用户目录 | `server/parsers/copilot.js` |
| `CHRONICLE_URL` | `http://localhost:4173` | pre-tool-use 守卫 hook 提交扫描请求的地址 | `hooks/chronicle-guard.mjs` |
| `PORT` | `41730` | 无界面 standalone 服务器的端口 | `server/standalone.js` |

> **注意：** `CHRONICLE_DATA_DIR` 是数据目录唯一的环境变量。在 `server/api.js` 内部，它解析后的值保存在一个名为 `CHRONICLE_DIR` 的常量中——那是一个内部名称，而不是第二个变量，因此只需设置 `CHRONICLE_DATA_DIR`，数据库和反馈日志便都会随之改变。

## `config.json` 覆盖

在数据目录中放置一个 `config.json`，即可在不使用环境变量的情况下设置持久化覆盖。目前唯一支持的键是反馈中继：

```json
{
  "feedbackRelay": "https://relay.example.com/feedback"
}
```

中继 URL 的优先级为：`CHRONICLE_FEEDBACK_RELAY` 环境变量 → `config.json` 中的 `feedbackRelay` → 内置默认值（`relay.getchronicle.dev`）。反馈总是先在本地追加到 `feedback.log`，因此即使中继不可达也不会丢失任何内容。

## 端口与绑定

三种运行模式都提供相同的 Express 应用（`/api`、`/share`、`/mcp`）；它们只在端口和外壳上有所不同。

| 模式 | 端口 | 绑定 |
| --- | --- | --- |
| `npm run dev` | `http://localhost:4173` | localhost |
| `npm run desktop`（Electron） | `41730` | 回环地址 |
| `npm run standalone` | `41730`（用 `PORT` 覆盖） | `127.0.0.1` |

standalone 服务器显式绑定到 `127.0.0.1`，因此仅能从你自己的机器访问——Chronicle 从不监听公共接口。

> **单实例锁：** 每台机器只能运行一个 Chronicle。Electron 外壳会取得单实例锁并占用端口 `41730`，因此第二次启动（打包后的应用、`electron .` 或残留的 `standalone.js`）会静默退出，而不会重复绑定。如果 UI 意外返回 404，可能有残留的服务器仍占用着该端口——检查 `lsof -iTCP:41730`。

## 相关内容

- [安装](../guide/installation.md) — 安装路径、运行模式与要求。
- [隐私与数据](./privacy-and-data.md) — 本地究竟存储了什么，以及那份简短的出站调用清单。
- [架构概览](../architecture/overview.md) — 为何单进程、单端口即可服务于每种模式。
