# Skills Hub

导入一个 agent skill 一次，即可到处使用：Chronicle 把每个 skill 存放在一个中心目录里，并通过符号链接分发给每个工具，因此单个真实文件能同时支撑 Claude Code、Cursor、Codex 和 Gemini。

Agent skills——一个 `SKILL.md` 加上它的支持文件——和 MCP 服务器有着同样的碎片化问题。把一个 skill 复制进 `~/.claude/skills`，然后又复制进 `~/.cursor/skills`，现在你就要维护两份彼此分岔的副本了。Skills Hub 用包管理器的方式解决了这个问题：中心存储里有一份规范副本，通过符号链接分发到每个工具。编辑中心文件，每个工具都会看到这个变更；你在某个工具里找到的 skill 会在所有工具中变得可用。它和 [MCP Hub](./mcp-hub.md) 采用的是同一套 **Takeover → Centralize → Distribute**（接管 → 集中 → 分发）模式，并且是**严格增量式的**——Chronicle 绝不会覆盖你已经拥有的 skill，且只会移除它自己创建的符号链接。

> **本地优先：** 扫描、导入、标签和评分全都发生在你的机器上。唯一的网络操作是对你所选择的某个公开仓库进行一次显式的 **GitHub 导入**；关于你的 skill 的任何内容都不会被上传。

## 分发是如何工作的

中心存储位于 **`~/.chronicle/skills/`**（`server/skills.js` 中的 `CENTRAL_SKILLS`）。导入一个 skill 会把它的目录复制到那里，而*分发*它则会从每个工具的 skill 目录创建一个指回那份中心副本的**符号链接**：

```
~/.chronicle/skills/my-skill/          ← the one real directory
  SKILL.md
  ...
~/.claude/skills/my-skill  → ~/.chronicle/skills/my-skill   (symlink)
~/.cursor/skills/my-skill  → ~/.chronicle/skills/my-skill   (symlink)
```

因为这些工具是透过符号链接读取的，所以恰好只有**一个文件需要编辑**，也没有副本需要保持同步。Chronicle 在建立链接时拒绝替换一个真实目录或一个外来符号链接，而在取消链接时它*只*移除指向它自己中心副本的链接——工具文件夹里的一个真实 skill 目录永远不会被触动。在 Windows 上，它使用 junction（不需要管理员权限）来代替目录符号链接。

分发目标：`~/.claude/skills`、`~/.cursor/skills`、`~/.codex/skills`、`~/.gemini/skills`。

## 扫描与导入

打开 **Skills Hub → Scan & import** 以在你的机器上搜寻 skill。Chronicle 会扫描各标准工具目录外加 `~/.agents/skills` 约定目录，解析每个 `SKILL.md` 前置元数据中的 `name` 和 `description`，并对找到的内容进行分类：

| 状态 | 含义 |
| --- | --- |
| **importable** | 一个真实的 skill，带有有效的 `SKILL.md`，尚未进入中心存储。 |
| **managed** | 已经是一个指向 Chronicle 中心存储的符号链接——无需处理。 |
| **duplicate** | 中心存储里已存在一个同名的 skill。 |
| **broken** | 没有 `SKILL.md`，或者是一个悬空的符号链接。 |

在某个来源分组上点击 **Import**，即可把它的 importable skill 复制进中心存储。原件保持不受触动（导入操作会解引用并复制），名称冲突则用数字后缀（`my-skill-2`）来消歧。一旦导入，skill 就会出现在 **Library** 里。

## Library（库）

Library 是一个由 skill 卡片组成的网格，包含：

- **搜索**——跨名称、描述和标签搜索。
- **按工具的链接状态**——为四个工具中的每一个显示一个标签：🔗 已链接、📁 真实目录（那里已有一个非 Chronicle 的 skill）、⚠️ 外来链接，或 · 无。点击某个标签即可就地为该工具建立或取消链接。
- **仅本地的标签和星级评分**——用来组织和排序你的 skill。它们存在于 Chronicle 的数据库中，**绝不会被上传**到任何地方。
- 一个**详情视图**，显示中心路径、文件列表、渲染后的 `SKILL.md`、版本历史，以及——对于从 GitHub 导入的 skill——一个上游检查。

## GitHub 导入

直接从一个公开仓库导入 skill（**Skills Hub → Scan & import → GitHub**）。给它一个公开的 HTTPS 仓库 URL、一个可选的分支（默认 `main`）和一个可选的子路径。Chronicle 会：

1. **浅克隆（Shallow-clone）**该仓库（`git clone --depth 1 --branch …`）到一个临时目录。
2. 记录它所克隆的确切**提交 SHA**。
3. **遍历目录树**（最深五层，跳过 `.git` 和 `node_modules`），查找每一个包含 `SKILL.md` 的目录。
4. **将每一个导入**到中心存储，并给它盖上仓库 URL、分支和 SHA 的印记，同时拍下一张永久快照。
5. 删除临时克隆。

日后，在一个从 GitHub 导入的 skill 上点 **Check upstream**，会运行 `git ls-remote`（不克隆）以将你记录的 SHA 与当前分支顶端进行比较。如果上游已经移动，重新导入即可拉取新版本。

## 版本历史

每个导入的 skill 在 **`~/.chronicle/snapshots/`** 下都有一份滚动的版本历史，因此编辑和上游更新都是可恢复的：

- **`imported`** 快照在导入时拍摄并**永久保留**。
- **`fs_change`** 快照在你编辑中心副本时自动拍摄——一个针对 `~/.chronicle/skills/` 的文件系统监视器，按每个 skill 做 500 ms 去抖——并作为每个 skill 的**滚动 50 张**保留。
- 内容相同的快照会按哈希**去重**，因此未改动的保存不会堆积。

详情视图的 **Version history** 时间线以最新在前列出快照，附带其触发方式、哈希和大小。**Restore** 会把中心副本回滚到任意快照——并且会先给当前状态拍快照，因此一次恢复本身也是可撤销的。因为工具是透过符号链接指向中心副本的，所以一次恢复无需重新链接即可在所有地方生效。

## 整套模式，端到端

1. **Takeover（接管）**——扫描你的工具目录（以及公开的 GitHub 仓库），把 skill 导入一个中心存储。
2. **Centralize（集中）**——在一处搜索、打标签、评分、拍快照和恢复；每个 skill 只编辑一个真实文件。
3. **Distribute（分发）**——用符号链接把每个 skill 分发给应当拥有它的工具。设计上是增量式的：你已有的任何东西都不会被覆盖，而从 hub 移除一个 skill 只会移除 Chronicle 自己的链接。

有关存储布局、符号链接扇出实现，以及快照引擎的内部机制，请参见下面的架构说明。

## 相关内容

- [MCP Hub](./mcp-hub.md) — 应用于 MCP 服务器的同一套 Takeover → Centralize → Distribute 模式。
- [安全与分享](./security-and-sharing.md) — 脱敏、pre-tool-use 守卫，以及安全的分享链接。
- [MCP 与 Skills 内幕](../architecture/mcp-and-skills-internals.md) — 中心存储、符号链接扇出，以及快照/版本历史引擎。
