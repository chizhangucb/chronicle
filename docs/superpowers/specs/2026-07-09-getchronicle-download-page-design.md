# getchronicle.dev download page — design

**Date:** 2026-07-09
**Status:** Approved (mockup reviewed), ready to build
**Author:** Chi + Claude

## Problem

Chronicle's README points "Or download the DMG" at the raw GitHub Releases page, which
dumps **11 assets** (arm64/x64 × dmg/zip/blockmap, `latest-mac.yml`, source archives).
Users can't tell which file to click. The reference bar is Mantra / Slack: one obvious
button that auto-detects the OS, with an "All platforms" table for everyone else.

Two adjacent questions were raised and **explicitly deferred**:
- **Binary size** (~101 MB DMG). The size is the Electron framework floor (the app's own
  `dist/` is 376 KB). Reaching Mantra's ~24 MB needs an Electron→Tauri swap, which is hard
  for Chronicle specifically because it ships a real Node backend Tauri can't host. Decision:
  **keep Electron**, revisit only if size provably blocks adoption. Not in scope here.
- **Windows/Linux builds** aren't published (only `dist:win`/`dist:linux` scripts exist).
  Out of scope, but the page is designed so they appear automatically once published.

## Goal

A single, elegant download page at **getchronicle.dev** that:
1. Auto-detects the visitor's OS and shows one primary download button.
2. Shows an "All platforms" table with real sizes, tracking the **latest** release.
3. Leads with the signed-&-notarized trust signal (no Gatekeeper warning).
4. Requires **zero release-time work** — new releases surface automatically.
5. Is light + dark theme-aware and mobile-responsive.

Non-goals: multi-page marketing site, blog, pricing, docs. This is a download-first landing
page that can grow later. YAGNI.

## Architecture

**Static site, no framework.** Plain `index.html` with inline CSS + a small vanilla-JS
`<script>`. Matches Chronicle's "one styles.css, no UI library" ethos; fast, cheap,
self-contained. No build step.

**Repo location:** new `website/` subdir at repo root — sibling to `feedback-relay/`,
consistent with the "extra deployable = its own root subdir" convention. Contents:
- `index.html` — the page
- `assets/` — the product screenshot (+ favicon/og image)
- `vercel.json` — static config (clean URLs, long-cache on `assets/`, no-cache on `index.html`)
- `README.md` — deploy notes

**Hosting:** its own Vercel project (e.g. `chronicle-web`), mapped to `getchronicle.dev`
apex + `www.getchronicle.dev`. This is a **third deployable** (after the app and
`feedback-relay/`) → the singleton/multi-worktree gotcha applies: **deploy from `main`
after merge**, never a feature branch. DNS: add the apex A/ALIAS record at Porkbun with the
values Vercel provides (`relay.getchronicle.dev` already resolves there). Porkbun's console
hangs in browser automation — Chi pastes DNS records manually; `dig` + `vercel --prod` verify.

### Live release data (the important decision)

On load, the page does a client-side
`fetch('https://api.github.com/repos/chizhangucb/homebrew-chronicle/releases/latest')`,
then:
- Reads `tag_name` (version) and `published_at` (date).
- Buckets `assets[]` by filename pattern: `-arm64.dmg` → mac/arm, `-x64.dmg` → mac/intel,
  `-Setup-*.exe` / `.msi` → windows, `.AppImage` / `.deb` / `.rpm` → linux. `.zip`,
  `.blockmap`, `.yml`, source archives are ignored.
- Renders version, date, sizes (`asset.size` bytes → MB), and `browser_download_url`s.
- Caches the response in `sessionStorage` to avoid refetching on reload.

**Fallback:** if the fetch fails (offline / rate limit), render a hardcoded last-known
release (`FALLBACK` constant: v0.1.7 + its two DMG URLs) plus a "View all releases" link,
so the page never looks broken. Unauthenticated GitHub API = 60/hr **per visitor IP**, a
non-issue for a download page.

**Consequence:** publishing a new release (or the first Windows/Linux build) needs **no page
change** — the page reads whatever the latest release contains. Deliberate, so the
already-long release checklist gains no step.

### OS / arch auto-detection

Detect OS from `navigator.userAgent`: macOS / Windows / Linux.
- **macOS →** default the primary button to **Apple Silicon**. In-browser ARM-vs-Intel
  detection is unreliable (UA reports "Intel" even on ARM Macs), so we don't try to be
  clever; Intel sits one row down in the table (exactly like Mantra). Optional progressive
  enhancement: if `navigator.userAgentData.getHighEntropyValues(['architecture'])` resolves
  `arm`/`x86` (Chromium only), refine the default.
- **Windows / Linux →** if a matching asset exists, button points at it; if not (current
  state), the button becomes "Build from source" linking to the repo's run-from-source
  section, and the table row shows "Coming soon". Never dead-ends the visitor.

### Theme

Token-based light + dark. Palette defined as CSS custom properties on `:root`; redefined
under `@media (prefers-color-scheme: dark)` and overridden by `:root[data-theme="dark"]` /
`:root[data-theme="light"]` so a manual toggle wins in both directions. Blue accent
`#4f8ef7` carries both grounds; green trust signal deepens to `~#1f9d6b` on light for
contrast. A small sun/moon toggle in the top-right persists choice to `localStorage`.

### Product screenshot

A **real capture** of Chronicle running, framed in a faux-macOS window (traffic-light
chrome bar) as `<img>` with explicit width/height, `max-width:100%`, and a 2× asset for
retina. **Privacy:** Chi's real sidebar lists private projects — the capture is framed on
the public `ai-session-manager` session (or cropped to the session view) so no private
project names or code ship on a public page. Chi approves the exact frame before deploy.
(The HTML/CSS mock from the brainstorming phase remains a clean fallback if a real capture
can't be framed safely.)

## Page structure

Hero (eyebrow · wordmark · tagline · auto-detected button · signed-&-notarized line ·
`Latest vX.Y.Z · updated <date>`) → framed product screenshot → release-timeline divider
(real version history, the time-machine motif) → 4 feature bullets → All-platforms table →
Homebrew one-liner with copy-to-clipboard → footer (GitHub, Releases, MIT).

## Reference repoint

- `README.md`: change the download link from the raw Releases URL → `https://getchronicle.dev`,
  and lead the install section with it.
- Follow-ups (noted, not blocking): the Homebrew tap `README` in `packaging/homebrew/`, and
  a one-line note in `CLAUDE.md` recording that `website/` → getchronicle.dev is a third
  deployable.

## Verification

Serve `website/index.html` locally (preview tools) and confirm:
- Live fetch renders the real latest release (v0.1.7): version, date, sizes, working URLs.
- OS detection: macOS → Apple Silicon button; spoof Windows/Linux UA → "Build from source".
- Fallback path: block the API → hardcoded release renders, no broken UI.
- Theme: toggle + `prefers-color-scheme` both work, accent legible on both grounds.
- Responsive: mobile width reflows the table and collapses the screenshot chrome.
- Screenshot: no private project names/code visible in the shipped frame.

## Rollout

Branch `feat/download-website` → PR → merge → **from `main`**: create the `chronicle-web`
Vercel project, add getchronicle.dev apex + www, paste Porkbun DNS, `vercel --prod`, verify
with `dig` + a live load. Then the README link is live.
