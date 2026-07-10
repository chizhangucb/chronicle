# 快速开始

安装 Chronicle，并在大约五分钟内抵达你的第一次**时间旅行**——点击一条消息，看着你的代码回弹到那一刻
它的样子。

Chronicle 的核心把戏体验起来很简单，却让人难忘：它把一次 AI 编程会话中的每一条消息都与你的 Git 历史
对齐，于是对话中的任意一点都成为通往代码确切状态的一扇窗。下面用几秒钟展示整个循环：

<Walkthrough />

无需账户、无需 API 密钥、无需联网——Chronicle 读取你的 AI 工具已经写入磁盘的日志，完全在你的机器上完成。

## 1 · 安装

**macOS —— 下载：** 从 **[getchronicle.dev](https://getchronicle.dev)** 获取应用。一个按钮，
自动识别 Apple Silicon 与 Intel。构建产物**已签名并公证**，因此打开时不会出现 Gatekeeper 警告。

**macOS —— Homebrew：**

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

**从源码运行**（任意平台——Windows/Linux 安装包尚未构建）：

```bash
npm install
npm run dev        # dev server → http://localhost:4173
```

安装之后，Chronicle 会保持自身更新——新的签名版本在后台下载，并提供一键式 **Relaunch to update**。
运行模式、要求和更多细节参见 [安装](./installation.md)。

## 2 · 选择一个由 Git 支持的项目

Chronicle 是穿越 **Git 提交**来做时间旅行的，所以请选择一个项目为 Git 仓库、且有一定历史的会话。提交
越多，Chronicle 就能越精确地重建消息之间的代码。没有仓库的项目仍能回放对话——你只是拿不到代码快照面板。

## 3 · 导入一个会话

1. **启动 Chronicle**（或 `npm run dev` → http://localhost:4173）。你会来到项目主页——首次运行时是空的。
2. 点击 **+ Import Sessions**。Chronicle 会扫描全部六种受支持工具的标准日志位置，并显示它找到的内容。
   选择一个来源——如果你有 Claude Code，它的信息最丰富。
3. 向导会列出带有 **NEW / Partial / Imported** 徽章的会话（新会话会被预选中）。点击 **Start Import**
   ——它是只读的，你的原始日志绝不会被触碰。

[导入会话](./importing-sessions.md) 涵盖完整流程和全部六种工具。

## 4 · 时间旅行

1. 回到主屏幕，点击一张**项目卡片**，然后点击任意一个**会话**。
2. 会话打开时停留在**概览 (Overview)**；从左侧栏切换到**回放 (Playback)**（或按 `⌘2`）。
3. **点击任意一条消息。** 中间面板会重建你的文件树和文件内容，呈现**它们在那一刻的样子**，解析到最近的
   前置提交。改动过的文件会带有绿点并被自动选中。按 `D` 查看差异。
4. **沿着 TimberLine 拖动**（底部）以擦洗整个会话，看着代码逐次提交地演进。

这就是那个“啊哈”时刻。[时间旅行](./time-travel.md) 会解释你所看到的一切。

> **本地优先：** 每一步都完全在你的机器上运行。Chronicle 没有做任何 LLM 调用，也没有任何云端请求——它把
> 本地日志解析进本地 SQLite 数据库，并从你自己的 Git 历史重建代码。查看会话的任何环节都不会离开你的笔记本。

## 接下来去哪儿

- 缺少某个来源，或想理解那些徽章？→ [导入会话](./importing-sessions.md)
- 完整的回放 / 差异 / 时间线参考 → [时间旅行](./time-travel.md)
- 概览标签页告诉你什么（成本、活跃时长、上下文）→ [会话洞察](./session-insights.md)

## 相关内容

- [安装](./installation.md) —— 深入了解运行模式、要求，以及自动更新。
- [导入会话](./importing-sessions.md) —— 导入向导、六种工具，以及只读保证。
- [时间旅行](./time-travel.md) —— 深入了解回放模式、快照、差异，以及 TimberLine。
