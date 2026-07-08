# getchronicle.dev Domain + Signed Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Chronicle feedback to `getchronicle.dev` (personal gmail never exposed), and give users a Claude-Code-style one-click "Relaunch to update" via signed builds + electron-updater — with the whole signing pipeline guarded so builds stay green until the Apple cert lands.

**Architecture:** Three code workstreams on branch `feat/domain-and-auto-update`: (A) point feedback addresses + the relay URL at getchronicle.dev; (B) scrub the gmail from the three code spots (git author already switched); (C) add guarded macOS signing/notarization config + rewrite the Electron updater to `electron-updater` with a preload/IPC bridge and an in-app Relaunch toast. Infra (Resend/Porkbun/Vercel/GitHub) and Apple enrollment are guided procedures done after the code PR (Appendix).

**Tech Stack:** Electron 43, electron-builder 26, electron-updater, @electron/notarize, React 19 + plain `styles.css`, Vite 8, Vercel serverless (relay), Resend, Porkbun DNS.

## Global Constraints

- **No test runner exists.** Verification is build- and preview-based (grep checks, `electron-builder --dir` unpacked builds, `npm run dev` + preview tools), matching this repo's "Verification habits". Do NOT introduce Jest/pytest.
- **Branch + PR, never commit to `main`.** Work stays on `feat/domain-and-auto-update`.
- **Git author is already `8743300+chizhangucb@users.noreply.github.com`** (local repo config). Do not change it; do not touch global config; do not rewrite history.
- **Client libs → `devDependencies`; only genuine server/runtime deps → `dependencies`.** `electron-updater` is the one intentional exception — it runs in the Electron main process at runtime and MUST ship, so it goes in `dependencies`. `@electron/notarize` is build-time → `devDependencies`.
- **Keep `asar: false`** — the server resolves `dist/` + parsers as loose files via `import.meta.url`. Signing still works (only mach-O binaries are signed).
- **Guarded signing:** `npm run dist:mac` must still succeed producing an UNSIGNED build when no `APPLE_*` credentials/cert are present. Signing + notarization engage automatically only when they are.
- **Publish feed:** GitHub, `owner: chizhangucb`, `repo: homebrew-chronicle` (existing public release feed powering the cask + update check).
- **Personal gmail (`<personal-inbox>`) must appear NOWHERE** in the repo/bundle after this. The gokite.ai maintainer email in `package.json`/`linux.maintainer` is intentional and stays.
- **Addresses:** feedback `to` = `feedback@getchronicle.dev`; `from` = `Chronicle Feedback <feedback@getchronicle.dev>`; branded relay URL = `https://relay.getchronicle.dev/api/feedback`.

---

## File Structure

**Modified:**
- `src/App.jsx` — mailto fallback address; add `UpdateBanner` component + render it.
- `server/api.js` — `DEFAULT_FEEDBACK_RELAY` → branded URL.
- `feedback-relay/api/feedback.js` — `FEEDBACK_TO`/`FEEDBACK_FROM` defaults.
- `feedback-relay/README.md` — documented defaults.
- `package.json` — `build.mac` signing keys, `build.publish`, `dist:mac`/`reinstall:mac` `--publish never`, deps.
- `electron/main.mjs` — replace hand-rolled updater with electron-updater; preload wiring; IPC; `before-quit-for-update`.
- `src/styles.css` — `.update-toast` styles.
- `src/i18n.js` — zh/ja entries for the 3 new UI strings.
- `CLAUDE.md` — release checklist + gotchas; remove the "signed auto-update" deferral.

**Created:**
- `build/entitlements.mac.plist` — hardened-runtime entitlements for notarization.
- `build/notarize.cjs` — afterSign hook that notarizes only when `APPLE_*` creds exist.
- `electron/preload.cjs` — contextBridge → `window.chronicleUpdater`.

---

## Task 1: Migrate feedback addresses + relay URL to getchronicle.dev, remove gmail

**Files:**
- Modify: `src/App.jsx:205`
- Modify: `server/api.js:169`
- Modify: `feedback-relay/api/feedback.js:18,21`
- Modify: `feedback-relay/README.md:24-25,32`

**Interfaces:**
- Produces: the branded relay URL constant and getchronicle.dev addresses other tasks don't depend on. Self-contained.

- [ ] **Step 1: Change the app's mailto fallback (ships in the UI — the worst exposure)**

In `src/App.jsx`, line 205, replace:
```jsx
      window.open(`mailto:<personal-inbox>?subject=${encodeURIComponent('Chronicle feedback')}&body=${encodeURIComponent(text.trim())}`);
```
with:
```jsx
      window.open(`mailto:feedback@getchronicle.dev?subject=${encodeURIComponent('Chronicle feedback')}&body=${encodeURIComponent(text.trim())}`);
```

- [ ] **Step 2: Point the baked-in relay default at the branded URL**

In `server/api.js`, line 169, replace:
```js
const DEFAULT_FEEDBACK_RELAY = 'https://feedback-relay-chizhangucb-projects.vercel.app/api/feedback';
```
with:
```js
const DEFAULT_FEEDBACK_RELAY = 'https://relay.getchronicle.dev/api/feedback';
```

- [ ] **Step 3: Change the relay's default addresses (removes the gmail default)**

In `feedback-relay/api/feedback.js`, lines 18-21, replace:
```js
  const to = process.env.FEEDBACK_TO || '<personal-inbox>';
  // onboarding@resend.dev needs no domain setup but only delivers to the Resend
  // account owner; verify a domain and set FEEDBACK_FROM to reach any inbox.
  const from = process.env.FEEDBACK_FROM || 'Chronicle Feedback <onboarding@resend.dev>';
```
with:
```js
  const to = process.env.FEEDBACK_TO || 'feedback@getchronicle.dev';
  // Resend sends to feedback@getchronicle.dev, which Porkbun forwards to the
  // maintainer's inbox. from must be on the Resend-verified getchronicle.dev domain.
  const from = process.env.FEEDBACK_FROM || 'Chronicle Feedback <feedback@getchronicle.dev>';
```

- [ ] **Step 4: Update the relay README defaults**

In `feedback-relay/README.md`, replace line 24:
```
vercel env add FEEDBACK_TO   production      # optional; default <personal-inbox>
```
with:
```
vercel env add FEEDBACK_TO   production      # optional; default feedback@getchronicle.dev
```
and replace line 25:
```
vercel env add FEEDBACK_FROM production      # optional; default onboarding@resend.dev
```
with:
```
vercel env add FEEDBACK_FROM production      # optional; default Chronicle Feedback <feedback@getchronicle.dev>
```
In the "About `FEEDBACK_FROM`" paragraph (~line 29-32), replace the `onboarding@resend.dev` example wording with getchronicle.dev:
```
**About `FEEDBACK_FROM`:** it must be an address on a domain you've verified in
Resend (here, `getchronicle.dev`). The relay sends to `feedback@getchronicle.dev`,
which Porkbun email-forwarding relays to the maintainer's inbox — so the personal
address never appears in this repo, the app bundle, Resend, or Vercel.
```

- [ ] **Step 5: Verify the gmail is gone and the client build still compiles**

Run:
```bash
cd /Users/chizhang/personal/ai-session-manager
grep -rn "gmail.com" . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=release
npm run build
```
Expected: the `grep` prints **nothing** (exit 1). `npm run build` finishes with `✓ built` and no errors.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx server/api.js feedback-relay/api/feedback.js feedback-relay/README.md
git commit -m "feat: route feedback to feedback@getchronicle.dev via relay.getchronicle.dev; remove personal email"
```

---

## Task 2: Guarded macOS signing + notarization build config

**Files:**
- Modify: `package.json` (`build.mac`, `build.publish`, `scripts.dist:mac`, `scripts.reinstall:mac`, `dependencies`, `devDependencies`)
- Create: `build/entitlements.mac.plist`
- Create: `build/notarize.cjs`

**Interfaces:**
- Produces: `build.publish` config (consumed at runtime by electron-updater via the generated `app-update.yml`); the `zip` + `latest-mac.yml` artifacts (consumed by Task 3's updater and the release process). Task 3 relies on `build.publish` being present so `autoUpdater` has a provider.

- [ ] **Step 1: Create the entitlements plist**

Create `build/entitlements.mac.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 2: Create the guarded notarize afterSign hook**

Create `build/notarize.cjs`:
```js
// electron-builder afterSign hook. Notarizes the signed .app ONLY when Apple
// credentials are present in the environment; otherwise it no-ops so unsigned
// builds keep working until enrollment completes. Prefers an App Store Connect
// API key (APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER); falls back to
// Apple ID + app-specific password (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID).
const { notarize } = require('@electron/notarize');

exports.default = async function notarizeHook(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const {
    APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER,
    APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID,
  } = process.env;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    console.log(`  • notarizing ${appName}.app via App Store Connect API key`);
    return notarize({ appPath, appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER });
  }
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    console.log(`  • notarizing ${appName}.app via Apple ID`);
    return notarize({ appPath, appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID });
  }
  console.log('  • notarization skipped — no APPLE_* credentials in env (unsigned build)');
};
```

- [ ] **Step 3: Update `build.mac`, add `build.publish` and the afterSign hook in `package.json`**

Replace the `"mac"` block (lines 38-43):
```json
    "mac": {
      "category": "public.app-category.developer-tools",
      "target": "dmg",
      "identity": null,
      "artifactName": "${productName}-${version}-${arch}.${ext}"
    },
```
with:
```json
    "mac": {
      "category": "public.app-category.developer-tools",
      "target": [
        "dmg",
        "zip"
      ],
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "artifactName": "${productName}-${version}-${arch}.${ext}"
    },
```
Note: `identity` is removed entirely so electron-builder auto-detects a Developer ID cert when present and skips signing (unsigned build) when absent. Do NOT re-add `identity: null` (that hard-disables signing).

Add an `"afterSign"` key and a `"publish"` key to the top-level `"build"` object (put them right after `"appId"`/`"productName"`, e.g. after line 22):
```json
    "afterSign": "build/notarize.cjs",
    "publish": {
      "provider": "github",
      "owner": "chizhangucb",
      "repo": "homebrew-chronicle"
    },
```

- [ ] **Step 4: Add `--publish never` to the mac build scripts and register deps**

In `package.json` `scripts`, change `dist:mac` (line 12) to:
```json
    "dist:mac": "npm run build && electron-builder --mac --arm64 --x64 --publish never",
```
and `reinstall:mac` (line 13) — add `--publish never` to its electron-builder invocation:
```json
    "reinstall:mac": "pkill -f 'Chronicle.app/Contents/MacOS/Chronicle' || true; npm run build && electron-builder --mac --arm64 --publish never && ditto release/mac-arm64/Chronicle.app /Applications/Chronicle.app && rm -rf release && open -a /Applications/Chronicle.app",
```
(`--publish never` guarantees the local build never attempts a network upload — the release checklist uploads assets manually; the `latest-mac.yml` is still generated locally.)

Add to `"dependencies"`:
```json
  "dependencies": {
    "electron-updater": "^6.3.9",
    "express": "^5.2.1"
  },
```
Add `@electron/notarize` to `"devDependencies"` (alphabetical, after `diff`):
```json
    "@electron/notarize": "^2.5.0",
```

- [ ] **Step 5: Install and verify the config parses + an UNSIGNED build still succeeds**

Run (the `--dir` unpacked build is fast — it skips DMG/zip packing but exercises signing config + the afterSign hook):
```bash
cd /Users/chizhang/personal/ai-session-manager
npm install
npm run build && npx electron-builder --mac --arm64 --dir --publish never
```
Expected: install adds `electron-updater` + `@electron/notarize`. The build prints `• notarization skipped — no APPLE_* credentials in env (unsigned build)` (or a "skipped macOS code signing" notice) and completes with the unpacked app under `release/mac-arm64/Chronicle.app`. **No hard failure** = the guard works.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json build/entitlements.mac.plist build/notarize.cjs
git commit -m "feat: guarded macOS signing + notarization config; zip target + github publish feed"
```
(If there is no `package-lock.json`, omit it from the `git add`.)

---

## Task 3: Rewrite the Electron updater to electron-updater + preload/IPC bridge

**Files:**
- Modify: `electron/main.mjs`
- Create: `electron/preload.cjs`

**Interfaces:**
- Consumes: `build.publish` from Task 2 (electron-updater reads the generated `app-update.yml`).
- Produces: IPC channels `update:downloaded` (main→renderer, payload `{ version }`), `update:available` (main→renderer, payload `{ version }`), `update:relaunch` (renderer→main, invoke), `update:check` (renderer→main, invoke); and `window.chronicleUpdater = { onDownloaded(cb), onAvailable(cb), relaunch(), check() }` in the renderer. Task 4's `UpdateBanner` consumes exactly these names.

- [ ] **Step 1: Create the preload bridge**

Create `electron/preload.cjs`:
```js
// Preload (CommonJS, sandboxed). Exposes a minimal updater API to the renderer
// via contextBridge. Present ONLY in the Electron shell — in the dev/standalone
// (browser) run modes window.chronicleUpdater is undefined, so the UI degrades
// to hiding the update toast entirely.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chronicleUpdater', {
  onDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, info) => cb(info)),
  onAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  relaunch: () => ipcRenderer.invoke('update:relaunch'),
  check: () => ipcRenderer.invoke('update:check'),
});
```

- [ ] **Step 2: Wire electron-updater, IPC, and the preload into `electron/main.mjs`**

Replace the imports line 1:
```js
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } from 'electron';
```
with (add `ipcMain` and the electron-updater default import + destructure):
```js
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
```

In `showWindow()`, add the preload to `webPreferences` (line 28). Replace:
```js
    webPreferences: { contextIsolation: true },
```
with:
```js
    webPreferences: {
      contextIsolation: true,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
    },
```

Replace the entire update block (lines 53-79 — the `UPDATE_FEED` const and the old `checkForUpdates` function) with:
```js
// Auto-update via electron-updater (NFR-7). Reads the github publish feed baked
// into app-update.yml at build time (owner/repo in package.json build.publish).
// autoUpdater only installs when the running app AND the update are signed by the
// same Developer ID — so this stays dormant until the first signed release.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:available', { version: info.version });
});
autoUpdater.on('update-downloaded', (info) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:downloaded', { version: info.version });
});
autoUpdater.on('error', (err) => {
  console.error('[updater]', err?.message || err);
});

// quitAndInstall triggers a real quit; let the window's close handler through
// instead of hiding to tray.
app.on('before-quit-for-update', () => { quitting = true; });

ipcMain.handle('update:relaunch', () => { quitting = true; autoUpdater.quitAndInstall(); });
ipcMain.handle('update:check', () => checkForUpdates(false));

async function checkForUpdates(interactive = false) {
  if (!app.isPackaged) {
    if (interactive) dialog.showMessageBox({ message: 'Updates are only available in the packaged app.' });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const current = app.getVersion();
    if (interactive && latest && latest === current) {
      dialog.showMessageBox({ message: `Chronicle ${current} is up to date.` });
    }
  } catch (err) {
    if (interactive) dialog.showMessageBox({ message: `Update check unavailable: ${err.message}` });
  }
}
```

The tray menu already calls `checkForUpdates` (line 47) — no change needed there; it now routes through electron-updater. In `app.whenReady()` the existing `checkForUpdates(false)` call (line 91) stays. Add a periodic check right after it:
```js
  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
```
(Replace the single existing `checkForUpdates(false);` line inside `whenReady` with these two lines.)

- [ ] **Step 3: Verify the shell boots, the bridge is exposed, and no updater runs in dev**

Run:
```bash
cd /Users/chizhang/personal/ai-session-manager
npm run build
```
Expected: build succeeds. Then a maintainer smoke-check (documented, run manually since it needs a GUI): quit any running Chronicle (`pkill -f 'Chronicle.app/Contents/MacOS/Chronicle' || true`), run `npm run desktop`, and in the app's devtools console confirm `typeof window.chronicleUpdater` is `'object'` and `window.chronicleUpdater.relaunch` is a function. Because `app.isPackaged` is false when run this way, `checkForUpdates` returns early — no network call, no `app-update.yml` error.

- [ ] **Step 4: Commit**

```bash
git add electron/main.mjs electron/preload.cjs
git commit -m "feat: electron-updater with preload/IPC bridge for in-app relaunch"
```

---

## Task 4: In-app Relaunch toast (React + styles + i18n)

**Files:**
- Modify: `src/App.jsx` (add `UpdateBanner`, render it)
- Modify: `src/styles.css` (`.update-toast`)
- Modify: `src/i18n.js` (zh + ja entries)

**Interfaces:**
- Consumes: `window.chronicleUpdater.onDownloaded(cb)` / `.relaunch()` from Task 3.

- [ ] **Step 1: Add the `UpdateBanner` component**

In `src/App.jsx`, add this component right after the `FeedbackModal` function (after its closing `}` near line 234):
```jsx
// Auto-update toast: shown only inside the Electron shell (window.chronicleUpdater
// exists) once an update has downloaded. Clicking Relaunch installs + relaunches
// via electron-updater's quitAndInstall (clean port handover — no stale process).
function UpdateBanner() {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    const u = typeof window !== 'undefined' ? window.chronicleUpdater : null;
    if (!u) return;
    u.onDownloaded((info) => setVersion(info?.version || ''));
  }, []);
  if (version === null) return null;
  return (
    <div className="update-toast" role="status">
      <div className="update-toast-body">
        <div className="update-toast-title">{t('Updated to')} {version}</div>
        <div className="update-toast-sub">{t('Relaunch to apply')}</div>
      </div>
      <button className="btn primary" onClick={() => window.chronicleUpdater?.relaunch()}>
        {t('Relaunch')}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Render `<UpdateBanner />` in the app root**

In `src/App.jsx`, inside the top-level `.app` div, add `<UpdateBanner />` right after the `{searchOpen && (...)}` block and before the closing `</div>` (around line 182):
```jsx
      {searchOpen && (
        <SearchModal onClose={() => setSearchOpen(false)}
          onOpen={(sid, pid) => { setSearchOpen(false); setView({ name: 'session', id: sid, projectId: pid }); }} />
      )}
      <UpdateBanner />
    </div>
  );
}
```

- [ ] **Step 3: Add the toast styles**

In `src/styles.css`, append (near the live-streaming section, e.g. after the `.new-msgs` rule):
```css
/* Auto-update relaunch toast (Electron shell only) */
.update-toast {
  position: fixed; right: 20px; bottom: 20px; z-index: 1000;
  display: flex; align-items: center; gap: 16px;
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 16px; max-width: 360px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
}
.update-toast-title { font-weight: 600; font-size: 14px; }
.update-toast-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.update-toast .btn.primary { white-space: nowrap; }
```

- [ ] **Step 4: Add zh + ja translations for the 3 new strings**

In `src/i18n.js`, add to the `zh` object (before its closing `};` at ~line 261):
```js
  'Updated to': '已更新至',
  'Relaunch to apply': '重启以应用',
  'Relaunch': '重启',
```
and to the `ja` object (before its closing `};` at ~line 512):
```js
  'Updated to': 'アップデート済み：',
  'Relaunch to apply': '再起動して適用',
  'Relaunch': '再起動',
```

- [ ] **Step 5: Verify the app renders (no toast in browser) and the toast renders when simulated**

Run the dev server and drive it with the preview tools:
```bash
cd /Users/chizhang/personal/ai-session-manager
npm run dev
```
Then, via the preview tools against `http://localhost:4173`:
1. `preview_snapshot` — the app loads normally and there is **no** `.update-toast` (browser has no `window.chronicleUpdater`). No console errors (`preview_console_logs level=error`).
2. Simulate an Electron download to confirm the toast + button render — `preview_eval`:
```js
(() => {
  window.chronicleUpdater = {
    onDownloaded: (cb) => cb({ version: '0.1.6' }),
    relaunch: () => { window.__relaunchCalled = true; },
  };
  window.location.reload();
})()
```
   After reload, `preview_snapshot` shows "Updated to 0.1.6 / Relaunch to apply / Relaunch"; `preview_click` the Relaunch button, then `preview_eval` `window.__relaunchCalled` → `true`. `preview_screenshot` for the record.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx src/styles.css src/i18n.js
git commit -m "feat: in-app Relaunch-to-update toast (Electron shell only)"
```

---

## Task 5: Update project docs (CLAUDE.md)

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the release checklist for the new artifacts**

In `CLAUDE.md`, the **Release checklist** bullet under `## Patterns`: after the `npm run dist:mac` step, note that it now also emits `.zip` + `latest-mac.yml` + `.blockmap` per arch, and the `gh release upload` step must upload **all** of `*.dmg *.zip latest-mac.yml *.blockmap` to the tap release (electron-updater needs the zip + yml + blockmap; the cask still points at the DMG). Add this sentence to the checklist bullet:
```
Auto-update needs the zip + latest-mac.yml + blockmap on the tap release too:
`gh release upload vX.Y.Z release/*.dmg release/*.zip release/latest-mac.yml release/*.blockmap`.
```

- [ ] **Step 2: Add gotchas for signing + updater**

In `CLAUDE.md` under `## Gotchas`, add:
```
- **Signing is guarded.** `build/notarize.cjs` (afterSign hook) notarizes only when
  `APPLE_*` creds are in env; `build.mac` has no `identity`, so electron-builder signs
  when a Developer ID cert is present and produces an UNSIGNED build otherwise. Do NOT
  re-add `identity: null` (hard-disables signing). `npm run dist:mac` must stay green
  with no Apple creds.
- **Auto-update = electron-updater**, feed = `build.publish` github `chizhangucb/
  homebrew-chronicle` (baked into `app-update.yml`). It installs only when the running
  app and the update share a Developer ID signature — dormant until the first SIGNED
  release. `quitAndInstall()` does the clean quit + swap + relaunch, replacing the old
  `pkill`/`reinstall:mac` dance for end users. Mac targets are `["dmg","zip"]`;
  electron-updater updates from the ZIP, not the DMG.
- **The Relaunch toast** needs the preload (`electron/preload.cjs` → `window.
  chronicleUpdater`) + IPC in `electron/main.mjs`. In dev/standalone (browser) the
  bridge is absent, so the toast never renders. Updater calls are guarded by
  `app.isPackaged` — `npm run desktop` runs unpacked, so no update runs there.
```

- [ ] **Step 3: Mark the deferral delivered**

In `CLAUDE.md`, in the "Known deferrals" line at the bottom (under "Verification habits used here"), remove `signed auto-update` from the deferred list (it is now implemented; only the live signed *release* awaits the Apple cert).

- [ ] **Step 4: Verify + commit**

```bash
cd /Users/chizhang/personal/ai-session-manager
grep -n "electron-updater\|guarded\|latest-mac.yml" CLAUDE.md | head
git add CLAUDE.md
git commit -m "docs: release checklist + gotchas for signing and electron-updater"
```

---

## Self-Review

- **Spec coverage:** A (relay URL + addresses) → Task 1; A infra → Appendix. B code scrub → Task 1; B git author → already done; B GitHub toggles → Appendix. C build config/guard/entitlements/notarize/zip/publish → Task 2; C updater/IPC/preload → Task 3; C toast/i18n/styles → Task 4; C docs → Task 5; C Apple enrollment + signed release → Appendix. All spec sections mapped. ✓
- **Placeholder scan:** no TBD/TODO; every code step shows full content. ✓
- **Type consistency:** IPC channel names + `window.chronicleUpdater` method names (`onDownloaded`, `onAvailable`, `relaunch`, `check`) match between Task 3 (preload/main) and Task 4 (renderer). Payload `{ version }` consistent. ✓

---

## Appendix — Guided procedures (after the code PR; not TDD tasks)

These are dashboard/enrollment actions. Per the spec, Claude drives the browser ones with the user; Apple enrollment is the user's track. Do them **after** Task 1-5 land.

### P1 — Resend (sending domain)
1. Resend → Domains → Add `getchronicle.dev` → copy the generated DKIM (`resend._domainkey`), SPF (`send.` TXT), and `send.` MX records.

### P2 — Porkbun DNS + forwarding (`getchronicle.dev`)
1. Paste the P1 records exactly (DKIM TXT/CNAME; `send.getchronicle.dev` MX + SPF TXT). Optional `_dmarc` TXT if Resend recommends.
2. Email Forwarding: `feedback@getchronicle.dev → <personal-inbox>` (this sets the **root** MX to Porkbun forwarding — coexists with the `send.` records).
3. DNS: `CNAME  relay → <target Vercel shows in P3>`.
4. Back in Resend, click Verify; wait for green.

### P3 — Vercel (`feedback-relay` project)
1. Settings → Environment Variables (Production): `FEEDBACK_TO=feedback@getchronicle.dev`, `FEEDBACK_FROM=Chronicle Feedback <feedback@getchronicle.dev>`. Keep `RESEND_API_KEY`.
2. Settings → Domains → add `relay.getchronicle.dev` (note the CNAME target for P2 step 3; TLS auto-provisions).
3. Confirm Deployment Protection / SSO is **OFF**.
4. Redeploy.

### P4 — GitHub email privacy
1. Settings → Emails → enable *Keep my email addresses private* + *Block command line pushes that expose my email*.

### P5 — Verify A/B end-to-end (after P1-P4)
```bash
curl -s -X POST https://relay.getchronicle.dev/api/feedback \
  -H 'content-type: application/json' \
  -d '{"message":"getchronicle.dev relay test","platform":"cli-verify"}'
```
Expected: `{"ok":true,"id":"..."}`, and the mail arrives in gmail via the `feedback@` forward with `from`/`to` showing only getchronicle.dev.

### P6 — Apple enrollment + first signed release (user's track, then Claude)
1. Enroll in the Apple Developer Program; create a **Developer ID Application** certificate; export `.p12` to the build keychain (or set `CSC_LINK`/`CSC_KEY_PASSWORD`).
2. Create an App Store Connect API key; set `APPLE_API_KEY` (path to `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` in the build env.
3. Bump `package.json` version, `npm run dist:mac` (now signs + notarizes), and follow the updated release checklist to upload `*.dmg *.zip latest-mac.yml *.blockmap` to the `homebrew-chronicle` release + update the cask shas.
4. Verify: `spctl -a -vv Chronicle.app` → accepted/notarized; install the prior signed version, publish a bumped one, confirm the Relaunch toast appears and `quitAndInstall` relaunches into the new version with a clean port handover.
