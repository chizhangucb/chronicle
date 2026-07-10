# Chronicle 文档

**Chronicle 是一个面向 AI 编程会话的本地优先时间机器。** 它导入你的 AI 编程助手已经写入的
对话日志，并将每一条消息映射到那一刻你代码的确切状态——这些状态由项目的 Git 历史重建而来。
点击任意一条消息，即可回到当时的代码。

一切都在你的机器上运行。**没有任何 LLM 调用，没有云端后端，你的源日志和项目仓库永远不会被写入**。
Chronicle 观察并整理你的 AI 工具；它绝不会取代它们。

Chronicle 目前可从六种工具导入——**Claude Code、Codex、Cursor、OpenCode、Gemini CLI
以及 GitHub Copilot Chat**——并将它们的会话统一到一个基于路径的项目视图中。

> **初来乍到？** 直接跳到 [快速开始](guide/quickstart.md)，在五分钟内抵达你的第一个
> 时间旅行时刻。

## 三大支柱

Chronicle 的设计理念是 **回放 · 掌控 · 安全 (Replay · Control · Secure)**：

- **回放 (Replay)** —— 对任意会话进行 [时间旅行](guide/time-travel.md)，确定性的
  [回放沙箱](guide/replay-mode.md)，用于将会话提炼为文档或可复用提示词的
  [提炼 (Refine)](guide/refine-mode.md)，以及将 AI 读取的内容与它所修改的内容关联起来的
  [上下文因果 (Context Causality)](guide/context-causality.md)。
- **掌控 (Control)** —— 一个跨越所有工具的统一控制平面，管理 [MCP 服务](guide/mcp-hub.md) 与
  [Skills](guide/skills-hub.md)：*接管*现有配置、将它们*集中化*，并将它们*分发*到各处。
- **安全 (Secure)** —— 一键 [安全检查与脱敏](guide/security-and-sharing.md)、实时的工具调用前
  拦截，以及本地托管的脱敏分享链接。所有解析与存储都留在设备上（参见
  [隐私与数据](reference/privacy-and-data.md)）。

## 指南

先把 Chronicle 跑起来，然后逐一探索各项功能。

| 页面 | 涵盖内容 |
| --- | --- |
| [安装](guide/installation.md) | Homebrew、已签名的 DMG、从源码运行，以及自动更新 |
| [快速开始](guide/quickstart.md) | 在五分钟内完成你的第一次时间旅行 |
| [导入会话](guide/importing-sessions.md) | 导入向导、全部六种来源，以及只读保证 |
| [时间旅行](guide/time-travel.md) | 回放模式、代码快照、差异视图，以及 TimberLine 时间线 |
| [搜索与筛选](guide/search-and-filtering.md) | 类型筛选标签、`⌘F` 搜索，以及 `⌘K` 命令面板 |
| [会话洞察](guide/session-insights.md) | 概览统计、活跃时长 (Active Duration)、成本与用量，以及上下文窗口条 |
| [提炼模式](guide/refine-mode.md) | 用保留 / 删除 / 编辑 / 插入提炼一个会话，然后导出 |
| [回放模式](guide/replay-mode.md) | 在隔离沙箱中进行确定性的重新执行 |
| [项目管理](guide/project-management.md) | 逻辑项目、关联、Git 药丸标签，以及同步 |
| [上下文因果](guide/context-causality.md) | 带置信度分级的启发式 读取 → 修改 关联 |
| [实时流式](guide/live-streaming.md) | 实时观看进行中的会话 |
| [MCP Hub](guide/mcp-hub.md) | 聚合式 MCP 服务器、配置接管、工具策略，以及 Inspector |
| [Skills Hub](guide/skills-hub.md) | 集中的 skill 存储、符号链接分发、GitHub 导入，以及版本管理 |
| [安全与分享](guide/security-and-sharing.md) | 安全检查、自定义规则、工具调用前钩子，以及分享链接 |

## 参考

| 页面 | 涵盖内容 |
| --- | --- |
| [键盘快捷键](reference/keyboard-shortcuts.md) | 按模式分组的每一个快捷键 |
| [兼容性](reference/compatibility.md) | 六工具支持矩阵与各工具日志位置 |
| [配置](reference/configuration.md) | `~/.chronicle/` 布局、环境变量，以及 `config.json` |
| [隐私与数据](reference/privacy-and-data.md) | 本地优先保证与确切的出站调用 |

## 架构

面向希望理解并扩展代码库的贡献者。

| 页面 | 涵盖内容 |
| --- | --- |
| [总览](architecture/overview.md) | 单进程/单端口设计、运行模式、组件地图，以及设计原则 |
| [数据模型](architecture/data-model.md) | SQLite 模式、规范化事件模型，以及 `replaceSession` |
| [解析器与摄取](architecture/parsers-and-ingestion.md) | 深入事件模型，以及如何添加新来源 |
| [Git 快照引擎](architecture/git-snapshot-engine.md) | 从 Git 历史重建代码状态 |
| [MCP 与 Skills 内部机制](architecture/mcp-and-skills-internals.md) | 注册表、hub、Streamable HTTP，以及 skill 分发 |
| [安全、实时与回放](architecture/security-live-replay.md) | 脱敏引擎、SSE 监听器、回放引擎，以及因果分析 |
| [API 参考](architecture/api-reference.md) | 每一条 REST 路由、SSE 流、`/mcp` 与 `/share` |
| [桌面端与打包](architecture/desktop-packaging.md) | Electron 外壳、签名、自动更新，以及发布流程 |

然后参见 [贡献指南](contributing.md)，了解开发环境搭建、分支与 PR 工作流，以及变更是如何被验证的。

## 项目背景

Chronicle 基于一份详尽的 [产品需求文档](AI-session-manager-PRD.md) 构建；它的
[决策日志](AI-session-manager-PRD.md#9-decision-log-post-implementation) 记录了哪些已经交付、
哪些被推迟。[`README`](../README.md) 承载了完整的功能清单，而
[`CHANGELOG`](../CHANGELOG.md) 追踪各次发布。

> **许可证：** Chronicle 采用 [MIT 许可证](../LICENSE)。
