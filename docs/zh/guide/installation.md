# 安装

如何在 macOS 上安装 Chronicle、在任意平台从源码运行它，以及要获得完整的时间旅行体验，机器需要具备什么。

Chronicle 以一个已签名、已公证的 macOS 应用形式发布，并会自我保持更新。没有云账户、无需登录、也没有要
搭建的服务器——一切都在本地运行，所以“安装”真的只是把二进制文件放到你的机器上（或从源码 `npm install`）。
本页涵盖这两条路径，以及解锁全部功能所需的一小组要求。

## 在 macOS 上安装

### Homebrew（推荐）

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

该 cask 发布在公开的 [`chizhangucb/homebrew-chronicle`](https://github.com/chizhangucb/homebrew-chronicle) tap 上，
该 tap 同时也托管 DMG 和更新源。`brew upgrade --cask chronicle` 会拉取新版本。

### 直接下载（DMG）

从 [Releases](https://github.com/chizhangucb/homebrew-chronicle/releases) 获取 DMG：

- **arm64** 适用于 Apple Silicon（M 系列）
- **x64** 适用于 Intel Mac

构建产物**使用 Apple Developer ID 签名并经过公证**，因此打开时不会出现 Gatekeeper 警告——你*无需*
`xattr -d com.apple.quarantine` 或 `--no-quarantine` 标志。只需把 Chronicle 拖到 `/Applications` 即可。

### 自动更新

安装之后，Chronicle 会保持自身最新。`electron-updater` 轮询发布源，在后台下载新的**已公证**构建，并在
构建就绪时弹出一个一键式 **“Relaunch to update”** 提示条。点击它会执行一次干净的退出并重启——无需手动
重装，也不会有陈旧进程占着端口。

> **注意：** 自动更新只会安装与正在运行的应用共享同一 Developer ID 签名的构建。第一个签名版本（v0.1.6）
> 是交接点——较旧的未签名副本手动升级一次，之后自动更新便会接管。

## 从源码运行

源码可在 macOS、Windows 和 Linux 上运行。它也是当前在 Windows 和 Linux 上运行 Chronicle 的*唯一*方式，
因为这些平台的原生安装包尚未构建。

```bash
npm install
```

然后选择一种运行模式。全部三种模式都提供**相同**的 Express 应用（`/api`、`/share`、`/mcp`）——它们仅在
UI 的提供方式，以及外面是否包裹着桌面外壳上有所不同。

| 命令 | 用途 | 端口 |
| --- | --- | --- |
| `npm run dev` | Vite dev server，API 在进程内挂载。API 路由在保存时热重载（按请求 `ssrLoadModule`）。开发时使用这个。 | http://localhost:4173 |
| `npm run desktop` | 用带系统托盘的 Electron 外壳包裹的生产构建。日常桌面体验。 | 41730 |
| `npm run standalone` | 无头生产服务器（UI + `/api` + `/share` + `/mcp`），绑定到 `127.0.0.1`。适合在不带 Electron 的情况下运行 Chronicle；用 `PORT` 覆盖端口。 | 41730 |
| `npm run build` | `vite build` → `dist/`。仅构建静态客户端包；不含服务器。 | — |

为何是一个端口、一个进程？Express 应用被直接挂载进 Vite dev server（通过 `vite.config.js` 中的一个
插件），在 Electron 下则由 `server/standalone.js` 在不经过 Vite 的情况下提供。你添加的任何端点无需额外
工作即可在全部三种模式中生效。架构总览对此有更深入的讲解。

要自行构建 macOS DMG：

```bash
npm run dist:mac   # electron-builder → arm64 + x64 DMGs in release/
```

## 要求

- 打包应用需要 **macOS 12+**。源码可在任何 Node 能运行的地方运行。
- **Git** —— 时间旅行所必需。Chronicle 通过对项目历史调用 `git`（只读）来重建代码快照，所以只有当项目
  是一个带有提交记录的 Git 仓库时，快照面板才会亮起。提交越频繁，回放的保真度越高；即便没有仓库，对话
  回放仍然可用，只是没有代码视图。
- **磁盘：** 应用本身约占 200 MB 的封装体积（其中约 100 MB 的下限是 Electron 框架），另需 ≥500 MB 的
  余量，用于 `~/.chronicle/` 下的本地 SQLite 数据库和回放沙箱。
- **内存：** 最低 4 GB，对于动辄数千条消息的大型会话推荐 8 GB 以上。

> **本地优先：** 这里的一切都不会向外通信。Chronicle 解析你的日志，将它们存入本地 SQLite 数据库，
> 并且绝不会写入你的原始日志或项目仓库。确切的出站调用清单（只有寥寥几个，且全部可选）参见
> [隐私与数据](../reference/privacy-and-data.md)。

## 相关内容

- [快速开始](./quickstart.md) —— 在五分钟内完成你的第一次时间旅行。
- [导入会话](./importing-sessions.md) —— 导入向导与六种受支持的工具。
- [配置](../reference/configuration.md) —— `~/.chronicle/` 布局、环境变量，以及 `config.json`。
