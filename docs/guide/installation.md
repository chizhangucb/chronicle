# Installation

How to install Chronicle, what your machine needs to give you full time-travel, and where
Chronicle stores its data.

Chronicle ships as an **npm package**. There is no cloud account, no sign-in, and nothing to
build — `npx chronicle-cli` downloads the package, starts a local web server, and opens your
browser to the dashboard. This page covers the prerequisite, the install paths, the CLI flags,
and where your data lives on disk.

## Prerequisite: Node.js 24+

Chronicle requires **Node.js 24 or newer**. Node 24 is what lets Chronicle run its server
`.ts` files directly — Node's built-in type stripping means there's no build step, no
transpiler, and no compiled server bundle to keep in sync. Node 24 is also required for
`node:sqlite`, the built-in SQLite driver Chronicle uses for its local database (no native
module compilation needed).

Check your version:

```bash
node -v
```

If it's below `v24`, install the latest from **[nodejs.org](https://nodejs.org)** (or via
`nvm install 24`). The `chronicle` launcher checks this itself and exits with a clear message
if your Node is too old.

## Run it — no install

```bash
npx chronicle-cli
```

This is the recommended way to run Chronicle. `npx` fetches the package (cached after the
first run), starts the local server, and opens your default browser to the dashboard. Press
`Ctrl-C` in the terminal to stop it. There's nothing left behind beyond npm's own package
cache — Chronicle's own data lives separately, under `~/.chronicle/` (see below), so it
survives even if you clear the npm cache.

## Install globally (optional)

If you run Chronicle often and don't want to wait on `npx` resolving the package each time:

```bash
npm install -g chronicle-cli
chronicle
```

Both `chronicle` and `chronicle-cli` are installed as the same binary — use whichever reads
better. To pick up new releases, run `npm install -g chronicle-cli` again (or
`npm update -g chronicle-cli`).

## CLI flags

```bash
npx chronicle-cli --port 5173     # run on a specific port instead of the default
npx chronicle-cli --no-open       # start the server without opening a browser tab
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--port <n>` | `41730` | Requested port. If it's taken, Chronicle scans forward (up to 50 ports) for a free one and tells you which port it actually bound. |
| `--no-open` | off | Skip auto-opening the browser — useful when running on a remote box or inside a script. |

On start, Chronicle prints the URL it's serving on (`http://localhost:<port>`) so you can open
it manually or point another tool at it.

## Where your data lives

Everything Chronicle writes lives under `~/.chronicle/` — one SQLite database
(`~/.chronicle/chronicle.db`) holding every imported project, session, and message. Override
the location with an environment variable:

```bash
CHRONICLE_DATA_DIR=/path/to/somewhere npx chronicle-cli
```

See [Privacy & data](../reference/privacy-and-data.md) for the full layout and the local-first
guarantees, and [Supported tools](../reference/supported-tools.md) for the environment
variables that control where each tool's logs are read from.

## Stopping and uninstalling

- **Stop the server:** `Ctrl-C` in the terminal running `npx chronicle-cli` (or `chronicle`).
  There's no background process, tray icon, or daemon — closing the terminal (or hitting
  Ctrl-C) ends it.
- **Uninstall the global install:** `npm uninstall -g chronicle-cli`.
- **Remove your data:** delete `~/.chronicle/` (or your `CHRONICLE_DATA_DIR`). This deletes the
  local database Chronicle built from your logs — it never touches your AI tools' original
  logs, so nothing is lost; re-running `npx chronicle-cli` and re-importing rebuilds it.

## Requirements

- **Node.js 24+** (see above) — the only hard requirement.
- **Git** — required for time travel. Chronicle reconstructs code snapshots by shelling out to
  `git` against your project's history (read-only), so a project needs to be a Git repo with
  commits for the snapshot panel to light up. More frequent commits mean higher-fidelity
  playback; conversation viewing still works without a repo, just without the code pane.
- **Disk:** the npm package itself is small (no bundled runtime); budget headroom for the local
  SQLite database under `~/.chronicle/` — a few hundred MB is comfortable even with thousands
  of imported sessions.
- **OS:** Chronicle runs anywhere Node 24 runs — macOS, Linux, and Windows.

## Related

- [Quickstart](./quickstart.md) — your first time-travel in a few minutes.
- [Supported tools](../reference/supported-tools.md) — the four supported tools, log locations,
  and configuration.
