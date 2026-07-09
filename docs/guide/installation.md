# Installation

How to install Chronicle on macOS, run it from source on any platform, and what the machine needs to give you full time-travel.

Chronicle ships as a signed, notarized macOS app and keeps itself up to date. There is no cloud account, no sign-in, and no server to stand up — everything runs locally, so "install" is genuinely just getting the binary onto your machine (or `npm install` from source). This page covers both paths and the small set of requirements that unlock every feature.

## Install on macOS

### Homebrew (recommended)

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

The cask is published to the public [`chizhangucb/homebrew-chronicle`](https://github.com/chizhangucb/homebrew-chronicle) tap, which also hosts the DMGs and the update feed. `brew upgrade --cask chronicle` pulls new versions.

### Direct download (DMG)

Grab the DMG from [Releases](https://github.com/chizhangucb/homebrew-chronicle/releases):

- **arm64** for Apple Silicon (M-series)
- **x64** for Intel Macs

Builds are **signed with an Apple Developer ID and notarized**, so they open with no Gatekeeper warning — you do *not* need `xattr -d com.apple.quarantine` or a `--no-quarantine` flag. Just drag Chronicle to `/Applications`.

### Auto-update

Once installed, Chronicle keeps itself current. `electron-updater` polls the release feed, downloads new **notarized** builds in the background, and surfaces a one-click **"Relaunch to update"** toast when a build is ready. Clicking it does a clean quit-and-relaunch — no manual reinstall, and no stale process left holding the port.

> **Note:** Auto-update only installs a build that shares a Developer ID signature with the running app. The very first signed release (v0.1.6) is the handoff point — an older unsigned copy upgrades once by hand, then auto-update takes over.

## Run from source

Source runs on macOS, Windows, and Linux. It is also the *only* way to run Chronicle on Windows and Linux today, since native installers for those platforms are not built yet.

```bash
npm install
```

Then pick a run mode. All three modes serve the **same** Express apps (`/api`, `/share`, `/mcp`) — they differ only in how the UI is served and whether there's a desktop shell around it.

| Command | What it's for | Port |
| --- | --- | --- |
| `npm run dev` | Vite dev server with the API mounted in-process. API routes hot-reload on save (per-request `ssrLoadModule`). Use this for development. | http://localhost:4173 |
| `npm run desktop` | Production build wrapped in the Electron shell with a system tray. The everyday desktop experience. | 41730 |
| `npm run standalone` | Headless production server (UI + `/api` + `/share` + `/mcp`), bound to `127.0.0.1`. Handy for running Chronicle without Electron; override the port with `PORT`. | 41730 |
| `npm run build` | `vite build` → `dist/`. Just the static client bundle; no server. | — |

Why one port and one process? The Express apps are mounted directly into the Vite dev server (via a plugin in `vite.config.js`) and served without Vite by `server/standalone.js` under Electron. Any endpoint you add works in all three modes for free. The architecture overview goes deeper into this.

To build macOS DMGs yourself:

```bash
npm run dist:mac   # electron-builder → arm64 + x64 DMGs in release/
```

## Requirements

- **macOS 12+** for the packaged app. Source runs anywhere Node does.
- **Git** — required for time travel. Chronicle reconstructs code snapshots by shelling out to `git` against your project's history (read-only), so a project must be a Git repo with commits for the snapshot panel to light up. More frequent commits mean higher-fidelity replay; conversation playback still works without a repo, just without the code view.
- **Disk:** the app itself is a ~200 MB envelope (the ~100 MB floor is the Electron framework), plus ≥500 MB headroom for the local SQLite database and replay sandboxes under `~/.chronicle/`.
- **RAM:** 4 GB minimum, 8 GB+ recommended for large multi-thousand-message sessions.

> **Local-first:** Nothing here phones home. Chronicle parses your logs, stores them in a local SQLite database, and never writes to your original logs or project repos. See [Privacy & data](../reference/privacy-and-data.md) for the exact list of outbound calls (there are only a few, all optional).

## Related

- [Quickstart](./quickstart.md) — your first time-travel in under five minutes.
- [Importing sessions](./importing-sessions.md) — the import wizard and the six supported tools.
- [Configuration](../reference/configuration.md) — the `~/.chronicle/` layout, environment variables, and `config.json`.
