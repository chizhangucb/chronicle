# Desktop Shell, Packaging & Auto-Update

Chronicle's desktop app is an Electron shell wrapped around the same headless server that runs in dev and standalone mode. This page explains the shell (`electron/main.mjs`), the `electron-builder` packaging config, and how signing, notarization, and auto-update fit together — at the level of *how it works and what's required*, not a command-by-command runbook.

The guiding constraint is that Electron is a **thin shell**: it starts the server, owns a window and a tray, and does auto-update — and nothing under `server/` imports Electron. That separation is what keeps a future Tauri swap a shell-level change rather than a rewrite. For install instructions and the release runbook, see [Installation](../guide/installation.md) and the release checklist in `CLAUDE.md`.

## The Electron shell (`electron/main.mjs`)

On launch the shell does four things, in order: acquire the single-instance lock, start the embedded server, build the tray, and show the window.

**Embedded server.** `startBackend()` imports `server/standalone.js` and calls `startServer(41730)` — the exact same Express apps (`/api`, `/share`, `/mcp`) served in every other mode. The window then just loads `http://localhost:41730`. There is no separate API process; the desktop app *is* the standalone server with a Chromium window attached.

**Tray keeps the MCP Hub alive.** Closing the window does **not** quit the app — the close handler calls `e.preventDefault()` and hides the window instead:

```js
win.on('close', (e) => {
  if (!quitting) { e.preventDefault(); win.hide(); }
});
```

The app stays resident in the system tray so the aggregating MCP Hub keeps serving downstream clients even with no window open. The only way to truly quit is the tray menu's **Quit (stops MCP Hub)** item, which sets `quitting = true` before `app.quit()`. `window-all-closed` deliberately does nothing — the app is meant to live in the tray.

**Single-instance lock.** `app.requestSingleInstanceLock()` guarantees one Chronicle per machine (it also owns port `41730`); a second launch focuses the existing window and exits. A stale process holding the lock or the port is the usual cause of a "new build won't start" symptom — see the packaging gotchas in `CLAUDE.md`.

**Tray icon ships as a data URL** (a base64 PNG built inline with `nativeImage.createFromDataURL`) so the app carries no binary image assets.

### The updater bridge

Auto-update runs entirely in the main process, but the "Relaunch to update" toast is rendered by the React UI, so the two are bridged by IPC through the preload:

- `electron/preload.cjs` exposes `window.chronicleUpdater` to the renderer.
- `main.mjs` forwards `update-available` / `update-downloaded` events to the window (`webContents.send`) and handles `update:relaunch` (→ `autoUpdater.quitAndInstall()`) and `update:check` back.

In dev or standalone (a plain browser, no preload), that bridge is absent, so the toast never renders — and all updater work is guarded by `app.isPackaged`, so `checkForUpdates()` no-ops in unpacked runs. The toast is only visible *after* an update downloads; its absence in dev is expected, not a bug.

## Build & packaging (`package.json` → `build`)

Packaging is `electron-builder`, configured entirely in `package.json`. The choices that matter:

| Setting | Value | Why |
| --- | --- | --- |
| `asar` | `false` | The server resolves `dist/` and parsers as plain files via `import.meta.url`; asar packing breaks those paths |
| `electronLanguages` | `en`, `zh_CN` | Strip the other locale bundles to shrink the app |
| `files` | `dist/`, `server/`, `electron/`, `hooks/`, `package.json` | Exactly what the runtime needs |
| `mac.target` | `dmg`, `zip` | DMG for download; **zip is what electron-updater updates from** |
| `mac.hardenedRuntime` | `true` | Required for notarization |
| `dmg.format` | `ULFO` | Strongest DMG compression electron-builder 26 accepts (not `ULMO`) |
| `publish` | github `chizhangucb/homebrew-chronicle` | The update feed + public download host |

### Dependency discipline

Only genuine **server-runtime** dependencies live in `dependencies` — `express` and `electron-updater`. Everything client-side (`react`, `react-dom`, `diff`) is a `devDependency`, because Vite bundles those into `dist/` and electron-builder ships *everything in `dependencies`* inside the app. A client library misfiled under `dependencies` silently fattens every build. **New client deps go in `devDependencies`.**

### Build scripts

| Script | Produces |
| --- | --- |
| `npm run build` | `vite build` → `dist/` |
| `npm run dist:mac` | Signed (if creds present) arm64 **and** x64 DMG + zip in `release/` |
| `npm run reinstall:mac` | arm64-only rebuild + local replace of `/Applications/Chronicle.app` |
| `npm run dist:win` | NSIS installer (cross-built; untested on real Windows) |
| `npm run dist:linux` | AppImage + `.deb` (untested on real Linux) |

Arch selection lives in the CLI flags, not the build config — that's why `dist:mac` builds both arches while `reinstall:mac` builds only arm64. Windows and Linux targets exist in config but are **not shipped** — those platforms run from source (see [Installation](../guide/installation.md)).

## Signing & notarization (conceptual)

macOS builds are signed with an Apple **Developer ID** and notarized, so they open with no Gatekeeper warning. The mechanism:

- **`build/notarize.cjs`** is the `afterSign` hook. It notarizes **only when `APPLE_*` credentials are present in the environment** — no creds, no notarization. This is deliberate: `npm run dist:mac` must stay green for a contributor with no Apple account, producing an unsigned build.
- **`build.mac` has no hardcoded `identity`.** electron-builder signs when a Developer ID cert is discoverable and produces an unsigned build otherwise. Do **not** re-add `identity: null` — that hard-disables signing.
- **Signing needs a dedicated keychain, not `CSC_LINK`.** The default `CSC_LINK=<p12>` path imports the cert into a throwaway temp keychain that can't reach the system Apple Root, so `codesign` fails to build the trust chain. The working approach uses a dedicated keychain added to the user search list (with the full leaf → intermediate → root chain). Team ID is `9W7B6USGG9`.

The exact keychain setup and notary env vars are an operational runbook — see the signing section of `CLAUDE.md` rather than duplicating it here.

> **Note:** v0.1.6 was the first signed release. Users on unsigned builds (≤0.1.5) upgrade once manually; after that, auto-update takes over.

## Auto-update

Auto-update is `electron-updater`. The feed is `build.publish` (github `chizhangucb/homebrew-chronicle`), baked into `app-update.yml` at build time — it is **not** hardcoded in `electron/main.mjs`. The flow:

1. `autoUpdater.checkForUpdates()` runs on launch and every 6 hours (packaged only).
2. `autoDownload` fetches a newer build in the background; the UI shows the **"Relaunch to update"** toast on `update-downloaded`.
3. `quitAndInstall()` (from the toast, via IPC) does the clean quit + swap + relaunch.

Two hard requirements make an update actually install:

- **The `package.json` version must equal the release tag** (minus the `v`), because electron-updater does a semver compare against the feed.
- **electron-updater updates from the zip, not the DMG** — so a release needs the `.zip` plus `latest-mac.yml` and the `.blockmap` uploaded alongside the DMG.

And the safety gate: **it installs only when the running app and the update share a Developer ID signature.** That's why auto-update stays dormant until the first signed release, and why signed users can't be pushed a tampered build.

## Homebrew distribution

The Homebrew cask lives in `packaging/homebrew/` and is published to the public `chizhangucb/homebrew-chronicle` tap, which also hosts the release DMGs and serves as the auto-update feed. Install is:

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

Because the tap repo *is* the publish target, each release needs matching releases on both the `chronicle` repo (the record) and the tap (public download + update feed), and the cask's version and both SHAs must track the DMGs. See the release checklist in `CLAUDE.md`.

## Related
- [Installation](../guide/installation.md) — install methods, run modes, requirements, auto-update UX.
- [Architecture overview](overview.md) — single process / single port and the zero-Electron-imports rule.
- [Configuration](../reference/configuration.md) — `~/.chronicle/` layout, env vars, `config.json`.
