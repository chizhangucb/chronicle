# 桌面端 Shell、打包与自动更新

Chronicle 的桌面应用是一层 Electron shell，包裹在那个既跑在 dev、也跑在 standalone 模式下的无界面服务器之外。本页解释这层 shell（`electron/main.mjs`）、`electron-builder` 打包配置，以及签名、公证与自动更新如何拼在一起——讲的是*它如何工作、需要什么*的层面，而非一条一条命令的操作手册。

指导性约束是：Electron 是一层**薄薄的 shell**——它启动服务器，掌管一个窗口和一个托盘，并负责自动更新——而 `server/` 之下没有任何东西导入 Electron。正是这种分离，让未来换成 Tauri 只是一次 shell 层面的变更，而非一次重写。安装说明与发布操作手册，见 [安装](../guide/installation.md) 和 `CLAUDE.md` 里的发布清单。

## Electron shell（`electron/main.mjs`）

启动时，这层 shell 按顺序做四件事：获取单实例锁、启动内嵌服务器、构建托盘、显示窗口。

**内嵌服务器。** `startBackend()` 导入 `server/standalone.js` 并调用 `startServer(41730)`——就是在其他每一种模式下都被提供的那几个完全相同的 Express 应用（`/api`、`/share`、`/mcp`）。窗口随后就只是加载 `http://localhost:41730`。没有单独的 API 进程；桌面应用*就是*那个 standalone 服务器，外加一个 Chromium 窗口。

**托盘让 MCP Hub 保持存活。** 关闭窗口**不会**退出应用——关闭处理器会调用 `e.preventDefault()` 并转而隐藏窗口：

```js
win.on('close', (e) => {
  if (!quitting) { e.preventDefault(); win.hide(); }
});
```

应用会常驻在系统托盘里，于是即便没有窗口打开，聚合式 MCP Hub 也持续为下游客户端服务。真正退出的唯一方式是托盘菜单里的 **Quit (stops MCP Hub)** 项，它会在 `app.quit()` 之前把 `quitting = true` 置上。`window-all-closed` 刻意什么都不做——这个应用注定要活在托盘里。

**单实例锁。** `app.requestSingleInstanceLock()` 保证每台机器只有一个 Chronicle（它同时占用端口 `41730`）；第二次启动会聚焦已存在的窗口并退出。一个占着锁或端口的过期进程，是「新构建不肯启动」这种症状的常见成因——见 `CLAUDE.md` 里的打包陷阱。

**托盘图标以 data URL 形式发布**（一个用 `nativeImage.createFromDataURL` 内联构建的 base64 PNG），因此应用不携带任何二进制图像资源。

### 更新器桥

自动更新完全跑在主进程里，但那个「重新启动以更新」提示条是由 React UI 渲染的，因此两者通过预加载脚本以 IPC 桥接起来：

- `electron/preload.cjs` 向渲染进程暴露 `window.chronicleUpdater`。
- `main.mjs` 把 `update-available` / `update-downloaded` 事件转发给窗口（`webContents.send`），并处理反向传回的 `update:relaunch`（→ `autoUpdater.quitAndInstall()`）与 `update:check`。

在 dev 或 standalone 中（一个普通浏览器，没有预加载脚本），那座桥是缺席的，因此提示条永远不会渲染——而且所有更新器工作都被 `app.isPackaged` 守着，所以在未打包的运行里 `checkForUpdates()` 是无操作。提示条只在一次更新下载完成*之后*才可见；它在 dev 中的缺席是预期之内的，不是 bug。

## 构建与打包（`package.json` → `build`）

打包用的是 `electron-builder`，完全在 `package.json` 里配置。真正要紧的选择：

| 设置 | 值 | 为什么 |
| --- | --- | --- |
| `asar` | `false` | 服务器通过 `import.meta.url` 把 `dist/` 和解析器当作普通文件来解析；asar 打包会破坏那些路径 |
| `electronLanguages` | `en`、`zh_CN` | 剥掉其他语言包以缩小应用 |
| `files` | `dist/`、`server/`、`electron/`、`hooks/`、`package.json` | 恰好是运行时所需的东西 |
| `mac.target` | `dmg`、`zip` | DMG 用于下载；**zip 才是 electron-updater 用来更新的东西** |
| `mac.hardenedRuntime` | `true` | 公证所必需 |
| `dmg.format` | `ULFO` | electron-builder 26 接受的最强 DMG 压缩（不是 `ULMO`） |
| `publish` | github `chizhangucb/homebrew-chronicle` | 更新源 + 公开下载宿主 |

### 依赖纪律

只有真正的**服务器运行时**依赖才位于 `dependencies`——`express` 和 `electron-updater`。一切客户端的东西（`react`、`react-dom`、`diff`）都是 `devDependency`，因为 Vite 会把它们打包进 `dist/`，而 electron-builder 会把 *`dependencies` 里的一切*都装进应用。一个被错放进 `dependencies` 的客户端库会悄悄地让每一次构建变胖。**新的客户端依赖放进 `devDependencies`。**

### 构建脚本

| 脚本 | 产出 |
| --- | --- |
| `npm run build` | `vite build` → `dist/` |
| `npm run dist:mac` | 已签名（如凭据存在）的 arm64 **和** x64 DMG + zip，放在 `release/` |
| `npm run reinstall:mac` | 仅 arm64 的重建 + 本地替换 `/Applications/Chronicle.app` |
| `npm run dist:win` | NSIS 安装器（交叉构建；未在真实 Windows 上测试过） |
| `npm run dist:linux` | AppImage + `.deb`（未在真实 Linux 上测试过） |

架构选择活在 CLI 标志里，而不在构建配置里——这就是为什么 `dist:mac` 会构建两种架构、而 `reinstall:mac` 只构建 arm64。Windows 和 Linux 目标在配置里存在，但**不发布**——那些平台从源码运行（见 [安装](../guide/installation.md)）。

## 签名与公证（概念性）

macOS 构建用一个 Apple **Developer ID** 签名并公证，因此它们打开时没有 Gatekeeper 警告。其机制：

- **`build/notarize.cjs`** 是那个 `afterSign` 钩子。它**仅当环境中存在 `APPLE_*` 凭据时**才公证——没有凭据，就不公证。这是刻意的：`npm run dist:mac` 对于一个没有 Apple 账户的贡献者必须保持绿灯，产出一个未签名的构建。
- **`build.mac` 没有硬编码的 `identity`。** 当一个 Developer ID 证书可被发现时，electron-builder 会签名，否则产出一个未签名的构建。**不要**重新加上 `identity: null`——那会硬性禁用签名。
- **签名需要一个专用钥匙串，而不是 `CSC_LINK`。** 默认的 `CSC_LINK=<p12>` 路径会把证书导入一个用完即弃的临时钥匙串，那里够不到系统的 Apple Root，于是 `codesign` 无法构建出信任链。可行的做法是使用一个被加入用户搜索列表的专用钥匙串（带上完整的 叶证书 → 中间证书 → 根证书 链条）。Team ID 是 `9W7B6USGG9`。

确切的钥匙串搭建与公证环境变量是一份运维操作手册——见 `CLAUDE.md` 的签名一节，而不是在这里重复它。

> **注意：** v0.1.6 是第一个签名发布版。使用未签名构建（≤0.1.5）的用户需手动升级一次；之后，自动更新就接管了。

## 自动更新

自动更新用的是 `electron-updater`。更新源是 `build.publish`（github `chizhangucb/homebrew-chronicle`），在构建时被烘焙进 `app-update.yml`——它**不是**硬编码在 `electron/main.mjs` 里的。流程：

1. `autoUpdater.checkForUpdates()` 在启动时以及每 6 小时运行一次（仅打包版）。
2. `autoDownload` 在后台拉取一个更新的构建；UI 在 `update-downloaded` 时显示那个**「重新启动以更新」**提示条。
3. `quitAndInstall()`（来自提示条，经由 IPC）执行干净的退出 + 交换 + 重新启动。

有两条硬性要求，让一次更新真正得以安装：

- **`package.json` 版本必须等于发布 tag**（去掉 `v`），因为 electron-updater 会对着更新源做一次 semver 比对。
- **electron-updater 从 zip 更新，而不是从 DMG**——因此一次发布需要把 `.zip` 加上 `latest-mac.yml` 和 `.blockmap` 与 DMG 一起上传。

以及那道安全关口：**只有当运行中的应用与该更新共享一个 Developer ID 签名时它才会安装。** 这就是为什么自动更新会一直休眠，直到第一个签名发布版；也是为什么无法向已签名的用户推送一个被篡改的构建。

## Homebrew 分发

Homebrew cask 位于 `packaging/homebrew/`，并被发布到公开的 `chizhangucb/homebrew-chronicle` tap，该 tap 同时托管发布用的 DMG，并充当自动更新源。安装方式是：

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

因为那个 tap 仓库*就是*发布目标，每一次发布都需要在 `chronicle` 仓库（作为记录）和该 tap（公开下载 + 更新源）两边各有一个相匹配的发布，并且 cask 的版本和两个 SHA 都必须跟得上 DMG。见 `CLAUDE.md` 里的发布清单。

## 相关

- [安装](../guide/installation.md) —— 安装方式、运行模式、要求、自动更新 UX。
- [架构总览](overview.md) —— 单进程 / 单端口，以及零 Electron 导入的规则。
- [配置](../reference/configuration.md) —— `~/.chronicle/` 目录布局、环境变量、`config.json`。
