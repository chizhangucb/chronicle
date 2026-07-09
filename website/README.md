# getchronicle.dev — download landing page

Static, single-page download site for Chronicle. Plain `index.html` (inline CSS + vanilla
JS), no build step. This is the **third deployable** in the repo (after the app and
`feedback-relay/`).

## What it does

- Auto-detects the visitor's OS and shows one primary download button (macOS defaults to
  Apple Silicon; Windows/Linux fall back to "build from source" until those builds ship).
- Fetches the **latest** release from the GitHub API at load time and renders the version,
  date, sizes, and download URLs — so **new releases appear with no code change here**.
- Falls back to a hardcoded last-known release (`FALLBACK` in the script) if the API is
  unreachable, so the page is never blank.
- Light + dark themed (respects OS preference; manual toggle persists to `localStorage`).

## Assets

- `assets/chronicle-shot.png` (+ optional `@2x`) — real screenshot of Chronicle. Framed on
  the **public** `ai-session-manager` session; must not show private project names/code.
  If the image is missing, the page falls back to a built-in HTML/CSS mock of the UI.
- `assets/og.png` — 1200×630 social-share image (optional; referenced in `<head>`).

## Local preview

```bash
python3 -m http.server 4321 --directory website
# → http://localhost:4321
```

The GitHub API call works from any origin (CORS-enabled), so the live release data renders
locally too.

## Deploy (from `main`, after merge — never a feature branch)

New Vercel project, static (framework preset "Other"), root directory `website/`:

```bash
cd website
vercel --prod          # authed as chizhangucb
```

Then in Vercel: add the domains `getchronicle.dev` (apex) + `www.getchronicle.dev`, and add
the DNS records Vercel provides at **Porkbun** (paste manually — Porkbun's console hangs in
browser automation). `relay.getchronicle.dev` already resolves to Vercel, so the apex is the
only new record. Verify with `dig getchronicle.dev` and a live load.

> Singleton gotcha: the Vercel project + the live domain are shared state. Deploy from
> `main` after merge so the deployed site matches what's committed.
