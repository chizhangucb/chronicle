# 贡献指南

如何搭建开发环境、代码库遵循的约定，以及变更是如何被验证的。如果你对内部机制还不熟悉，请先阅读
[架构总览](architecture/overview.md)。

## 开发环境搭建

```bash
npm install
npm run dev        # Vite dev server + API in one process → http://localhost:4173
```

`npm run dev` 是最快的开发循环：Express API 被挂载在 Vite dev server 内部，因此 React UI 和
服务端模块在同一进程、同一端口上一起热重载。关于三种运行模式（`dev`、`desktop`、`standalone`）
为何都提供同一套 Express 应用，参见 [总览](architecture/overview.md)。

要体验打包后的效果：

```bash
npm run desktop    # production build + Electron shell (port 41730, tray)
npm run standalone # headless production server (UI + /api + /share + /mcp)
```

Chronicle 将其全部数据写入 `~/.chronicle/`（可用 `CHRONICLE_DATA_DIR` 覆盖）。你在开发中所做的
一切都不会触及你的源日志或项目仓库——Chronicle 对外部数据严格只读。完整的目录布局和环境变量参见
[配置](reference/configuration.md)。

## 约定

- **将新增端点保留在现有的 Express 应用中**（`server/api.js`、`server/shares.js`、
  `server/mcp/hub.js`）。因为这些应用在全部三种运行模式中都会被挂载，所以在此添加的路由无需额外工作
  即可在 dev、desktop 和 standalone 中生效。
- **纯 React + 一个 `styles.css`。** 没有 UI 框架，也没有图表库——图表是手写的 SVG/CSS
  （折线图和 conic-gradient 甜甜圈图）。请保持这一风格。
- **一切繁重逻辑都是启发式且本地的。** 因果分析、脱敏和成本核算完全在设备上运行，不做任何 LLM 调用。
  请保持这一离线保证——绝不要为核心功能引入网络依赖。
- **对外部系统只读。** SQLite 来源在打开前会被复制到临时位置（连同它们的 `-wal`/`-shm` 文件）；
  原始日志和仓库永远不会被写入。
- **长期存活的状态存放在 `globalThis` 上**（`__chronicleLive`、`__chronicleHub`、
  `__chronicleSkillWatch`），这样 Vite 的 SSR 模块重载才不会遗弃监听器或子进程。
- **共享词汇只有单一事实来源。** 聊天类型标签只存在于 `src/kinds.js`；各模型的上下文窗口和价格
  只存在于 `src/models.js`。新的措辞或数字请加到那里，绝不内联写死。
- **新增的客户端 npm 依赖放入 `devDependencies`**，而非 `dependencies`——Vite 会把客户端库
  打包进 `dist/`，而 electron-builder 会把 `dependencies` 里的一切都装进应用。只有真正的服务端
  运行时依赖（`express`、`electron-updater`）才属于 `dependencies`。
- **破坏性或对用户可见的操作先备份**（备份到 `~/.chronicle/backups/`）并需要一次明确的点击。
  脱敏是不可逆的；回放在沙箱中运行。

## 分支与 PR 工作流

对任何非琐碎的变更都使用分支和拉取请求——一个 `fix/…` 或 `feat/…` 分支，推送后用 `gh pr create`，
即便是单人开发也一样。仅将直接提交到 `main` 保留给琐碎的、已达成一致的一次性改动。PR 合并后，
把你的本地检出切回 `main`：

```bash
git checkout main && git pull && git fetch --prune && git branch -D <branch>
```

UI 中项目卡片上的 **Git 药丸标签** 会在每次 `/api/projects` 调用时读取检出的实时分支（无缓存），
因此如果它在合并后仍显示某个功能分支，说明检出仍停留在那个分支上——切回 `main` 即可。

## 验证变更

项目没有接入单元测试运行器。解析器通过 `test/fixtures/` 中的固件进行验证，功能则针对真实数据端到端
验证。最快的端到端检查是**导入 Chronicle 自己的 Claude Code 会话并四处点击**——时间旅行、因果分析
和回放都能在 Chronicle 自身的构建历史上运行。

功能已针对本仓库自身的会话、`~/health-analyst` 仓库（234 次提交）、在线的 `anthropics/skills`
仓库（用于 GitHub skill 导入），以及 Cursor、Codex、Gemini、Copilot 和 OpenCode-live 的固件
数据库/JSON 进行了验证。相比 mock，更推荐这样做：一次真实导入会一次性走完整条流水线
（扫描 → 解析 → 快照 → 渲染）。

当你添加一个新的来源工具时，请遵循
[解析器与摄取](architecture/parsers-and-ingestion.md#howto-add-a-new-source) 中的操作步骤，并在提交
PR 之前用一个固件加上一次真实会话来验证它。

## 各部分所在位置

[架构](architecture/overview.md) 章节详细描绘了代码库。简而言之：

```
server/     Express API + parsers + Git engine + live/replay/security/mcp/skills/shares
src/        React UI (Vite) — plain React + one styles.css
electron/   Desktop shell (tray, single instance, auto-update)
hooks/      chronicle-guard.mjs — the Claude Code PreToolUse hook
docs/       This documentation set
```

## 相关内容

- [架构总览](architecture/overview.md) —— 系统设计与运行模式
- [解析器与摄取](architecture/parsers-and-ingestion.md) —— 添加一个新的来源工具
- [API 参考](architecture/api-reference.md) —— 可供开发对接的每一条路由
