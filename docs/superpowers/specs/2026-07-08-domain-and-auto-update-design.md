# Chronicle — getchronicle.dev domain, feedback privacy, and signed auto-update

**Date:** 2026-07-08
**Status:** Approved design → ready for implementation plan
**Branch:** `feat/domain-and-auto-update`

## Goal

Three polish workstreams, driven by three user goals:

1. Migrate feedback email to the newly-purchased `getchronicle.dev` domain (Resend +
   anywhere a specific domain is required), including a branded relay URL.
2. Route feedback to `feedback@getchronicle.dev`, forwarded to the maintainer's
   personal gmail — with the personal gmail **never exposed** in the repo, the shipped
   app bundle, Resend, or Vercel. The current commit exposes it; remove that.
3. Give users a Claude-Code-Desktop-style **"Relaunch to update"** experience so
   updating is one click and never leaves a stale old process holding the port — the
   pain point behind the `reinstall:mac` / `pkill` dance.

## Decisions locked during brainstorming

- **Updater approach:** proper **code signing + notarization + `electron-updater`**
  (not an unsigned self-updater). `autoUpdater.quitAndInstall()` performs the clean
  quit + bundle swap + relaunch, eliminating the stale-process problem at the root.
- **Apple account:** *not enrolled yet.* Therefore **build the full pipeline now,
  guarded** so `dist:mac` keeps producing (unsigned) builds until the cert lands;
  signing + notarization + working auto-update switch on automatically once the
  `Developer ID Application` cert and `APPLE_*` credentials are present.
- **Email exposure:** **fix-forward** (no git history rewrite). Scrub the gmail from
  code; switch the *future* git author to GitHub's privacy noreply.
- **Infra execution:** Claude drives Resend / Porkbun / Vercel via the Chrome
  extension, confirming each step with the user.
- **Branded relay URL** `relay.getchronicle.dev`: **included** (additive; the existing
  `*.vercel.app` URL keeps working for already-shipped apps).
- **Git author (already applied):** local repo `user.email` set to
  `8743300+chizhangucb@users.noreply.github.com`; global config untouched; no history
  rewritten.

## Non-goals

- No git history rewrite / force-push (fix-forward only).
- No Windows/Linux auto-update work (macOS is the shipped target; `dist:win`/`dist:linux`
  remain untested best-effort). Config changes must not break those builds.
- No change to the offline/local-first guarantee: feedback + update check remain the
  only outbound network features, as documented.

---

## Workstream A — getchronicle.dev feedback flow

### Data flow

```
User's Chronicle
  → POST https://relay.getchronicle.dev/api/feedback   (Vercel function, holds Resend key)
  → Resend sends: from "Chronicle Feedback <feedback@getchronicle.dev>"
                  to   feedback@getchronicle.dev
  → Porkbun email forwarding: feedback@getchronicle.dev → <personal-inbox>
```

The personal gmail exists **only** in Porkbun's forwarding rule. It is absent from the
repo, the shipped bundle, Resend config, and Vercel env.

### Resend (sending domain)

- Add `getchronicle.dev` as a domain in Resend; complete verification.
- Resend generates account-specific DNS records: a DKIM record (`resend._domainkey…`
  TXT/CNAME), an SPF TXT on the `send.` subdomain, and an MX on `send.getchronicle.dev`
  for the Return-Path. These are the exact values pasted into Porkbun.

### Porkbun DNS + forwarding

- **Root-level email forwarding:** `feedback@getchronicle.dev → <personal-inbox>`
  (Porkbun's forwarding UI sets the **root MX** to Porkbun's forwarding servers).
- **Resend records** live on the `send.` subdomain (its own MX + SPF TXT) plus the
  DKIM record — so they **coexist with root-MX forwarding without conflict** (different
  hostnames).
- Optional DMARC TXT on `_dmarc` (relaxed policy) if Resend recommends it.
- **`relay` CNAME:** `relay → <target Vercel shows>` (typically `cname.vercel-dns.com`)
  for the branded relay URL.

### Vercel (`feedback-relay` project)

- Env vars (Production): `FEEDBACK_TO=feedback@getchronicle.dev`,
  `FEEDBACK_FROM=Chronicle Feedback <feedback@getchronicle.dev>`. `RESEND_API_KEY`
  stays as-is. Redeploy so env takes effect.
- Add custom domain `relay.getchronicle.dev` to the project (auto-provisions TLS once
  the CNAME resolves).
- Deployment Protection / SSO must remain **OFF** (a public endpoint); the custom
  domain inherits the project setting.

### Code

- `server/api.js`: `DEFAULT_FEEDBACK_RELAY` →
  `https://relay.getchronicle.dev/api/feedback`. (Old builds keep hitting the
  `*.vercel.app` URL, which remains live — the change only affects new builds.)
- `feedback-relay/api/feedback.js`: defaults become the getchronicle.dev addresses
  (see Workstream B — same edit removes the gmail default).
- `feedback-relay/README.md`: update the documented defaults + the `FEEDBACK_TO` note.

---

## Workstream B — remove the personal email (fix-forward)

### Code scrub (the three current exposures)

| Location | Now | After |
|---|---|---|
| `src/App.jsx:205` (mailto fallback — **ships in the app UI**) | `mailto:<personal-inbox>` | `mailto:feedback@getchronicle.dev` |
| `feedback-relay/api/feedback.js:18` (`FEEDBACK_TO` default) | `<personal-inbox>` | `feedback@getchronicle.dev` |
| `feedback-relay/api/feedback.js:21` (`FEEDBACK_FROM` default) | `onboarding@resend.dev` | `Chronicle Feedback <feedback@getchronicle.dev>` |
| `feedback-relay/README.md:24-25` (documented defaults) | mentions gmail | getchronicle.dev addresses |

After this, `grep -rn "gmail.com" .` (excluding `.git/`) returns nothing.

### Git author

- **Done:** local repo `user.email = 8743300+chizhangucb@users.noreply.github.com`.
- **Dashboard (belt-and-suspenders):** GitHub → Settings → Emails → enable *Keep my
  email addresses private* and *Block command line pushes that expose my email*.

### Explicitly not done

- Past commits keep `<personal-inbox>` as author (fix-forward). Purging that would
  require a full history rewrite + force-push, which was declined.

---

## Workstream C — signed auto-update with in-app Relaunch

### Prerequisite (user)

Enroll in the Apple Developer Program; create a **Developer ID Application**
certificate; export a `.p12`; generate notarization credentials (App Store Connect API
key — issuer id, key id, `.p8` — preferred over Apple-ID + app-specific password).
Provide these as env/keychain so signing can engage.

### Build config (`package.json` → `build.mac`)

- Remove `identity: null` (it hard-disables signing).
- Add `hardenedRuntime: true`, `gatekeeperAssess: false`.
- Add an entitlements plist (`build/entitlements.mac.plist`) with the Electron-required
  keys: `com.apple.security.cs.allow-jit`,
  `com.apple.security.cs.allow-unsigned-executable-memory`,
  `com.apple.security.cs.disable-library-validation`. Reference it via `entitlements`
  and `entitlementsInherit`.
- `target`: `["dmg", "zip"]` — **electron-updater updates from the `.zip`**, not the
  DMG; the DMG stays for first-install + the Homebrew cask.
- `build.publish`: GitHub provider, `owner: chizhangucb`, `repo: homebrew-chronicle`
  (the existing public release feed powering the cask + update check). This bakes an
  `app-update.yml` into the app that `electron-updater` reads.

### Guarding (keep interim builds green)

Signing + notarization must **only engage when credentials are present**. Approach:
notarization is not hard-coded on in `package.json`; a thin wrapper (npm script env
check or an electron-builder config gate) enables `notarize` + identity only when
`APPLE_TEAM_ID` (and the signing cert) are set. Absent creds → electron-builder logs
"skipped code signing" and produces an unsigned DMG/zip exactly as today. Verify
`npm run dist:mac` still succeeds with no Apple creds before merging.

### Updater rewrite (`electron/main.mjs`)

- Add `electron-updater` as a **runtime `dependencies`** entry (it runs in the main
  process and must ship inside the app; electron-builder bundles it). This is the one
  intentional exception to "client libs → devDependencies".
- Replace the hand-rolled `fetch(UPDATE_FEED)` GitHub-API poll + `shell.openExternal`
  with `autoUpdater`:
  - On app ready and on a periodic interval, `autoUpdater.checkForUpdates()`.
  - Keep the tray **"Check for updates"** item → triggers a check; when already current,
    show the existing "up to date" dialog (interactive path preserved).
  - Events: `update-available` → (auto-)download; `update-downloaded` → notify the
    renderer to show the Relaunch pill; `error` → log, stay silent unless interactive.
- **Tray/close interplay:** on `before-quit-for-update`, set the existing `quitting`
  flag so the window `close` handler does not `preventDefault()` (otherwise the
  hide-to-tray behavior would block the install). `quitAndInstall()` then performs the
  clean quit + swap + relaunch.
- `autoUpdater` only actually installs when the running app is signed and the update is
  signed by the same identity — so this stays dormant until the first signed release,
  by design.

### In-app Relaunch pill (matches the reference screenshot)

- Add a **CommonJS preload** (`electron/preload.cjs`) that uses `contextBridge` to
  expose `window.chronicleUpdater`:
  `{ onDownloaded(cb), onAvailable(cb), relaunch(), check() }` over `ipcRenderer`.
  Wire `webPreferences.preload` in `showWindow()`.
- Main process handles `ipcMain` `'update:relaunch'` → set `quitting = true` →
  `autoUpdater.quitAndInstall()`.
- Add a React `UpdateBanner` in `src/App.jsx`: when `window.chronicleUpdater` exists and
  fires `downloaded` with a version, render a card/pill —
  *"Updated to X.Y.Z / Relaunch to apply / [Relaunch]"* — styled in the existing
  `styles.css` dark theme (no UI framework). The button calls
  `window.chronicleUpdater.relaunch()`.
- In the **dev and standalone run modes** there is no Electron/preload, so
  `window.chronicleUpdater` is `undefined` and the banner never renders. No guard leaks
  into the web build.

### Release pipeline + docs

- `npm run dist:mac` now additionally emits `.zip`, `latest-mac.yml`, and `.blockmap`
  per arch. Build both arches in one electron-builder run so a single `latest-mac.yml`
  covers arm64 + x64 (electron-updater v6 selects the matching arch).
- The release checklist (CLAUDE.md) uploads **all** of `*.dmg`, `*.zip`,
  `latest-mac.yml`, `*.blockmap` to the tap release (electron-updater needs the zip +
  yml + blockmap; the cask still points at the DMG).
- Update CLAUDE.md: the "signed auto-update" deferral is now delivered; add gotchas for
  the guarded signing, the zip/yml assets, and the preload/IPC path. The manual
  `pkill`/`reinstall:mac` guidance stays only as a local-dev note, not the user upgrade
  path.

---

## Sequencing / who does what

1. **Now — Claude, no blockers:** all code changes — B scrub, C build config +
   entitlements + updater rewrite + preload + `UpdateBanner` (guarded, builds stay
   green pre-cert), A code (`DEFAULT_FEEDBACK_RELAY`, relay defaults, README). One
   branch + PR (`feat/domain-and-auto-update`).
2. **Browser-driven with the user (Claude drives, user logged in):** Resend domain
   verification, Porkbun DNS + forwarding + `relay` CNAME, Vercel env + custom domain,
   GitHub email-privacy toggles.
3. **User:** Apple Developer enrollment (start early — up to a day), then provide
   cert + notarization creds for a signed release + end-to-end verification.

## Verification

- **A/B:** after infra, POST a test message through the relay and confirm it lands in
  gmail via the `feedback@` forward; confirm `from`/`to` headers show only
  getchronicle.dev; `grep -rn "gmail.com" .` (excl. `.git/`) is empty.
- **C interim (pre-cert):** `npm run dev` renders no banner (no Electron); `npm run
  dist:mac` succeeds **unsigned** with no Apple creds (guard works).
- **C signed (post-cert):** publish a signed release with a bumped version; a running
  older signed build detects it, downloads, shows the Relaunch pill, and
  `quitAndInstall` relaunches into the new version with the port cleanly handed over
  (no stale process). `spctl -a -vv Chronicle.app` reports accepted/notarized.

## Risks / watch-items

- **Notarization entitlements:** Electron + `node:sqlite` + `git` shell-outs notarize
  fine in practice, but the entitlements set must be correct or notarization fails;
  validate on the first signed build.
- **`asar: false`** (kept — the server resolves `dist/` + parsers as loose files):
  signing still works (only mach-O binaries are signed; JS is not). Do not enable asar.
- **Per-arch update feed:** a single `latest-mac.yml` must include both arches; verify
  the updater picks arm64 vs x64 correctly.
- **Old shipped apps** keep the baked-in `*.vercel.app` relay URL — that endpoint must
  remain live after the custom domain is added (Vercel serves both).
