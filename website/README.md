# getchronicle.dev — landing + docs

The public site for Chronicle. **Third deployable** in the repo (after the app and
`feedback-relay/`). It has two halves, combined into one Vercel deployment:

- **`/`** — the static download **landing page** (`index.html`, inline CSS/JS, no framework).
- **`/docs/*`** — the **documentation**, built with [VitePress](https://vitepress.dev) from
  the repo's canonical Markdown in [`../docs`](../docs).

## The landing page (`/`)

Static, single-page `index.html`:

- Auto-detects the visitor's OS and shows one primary download button (macOS defaults to
  Apple Silicon; Windows/Linux fall back to "build from source" until those builds ship).
- Fetches the **latest** release from the GitHub API at load time and renders the version,
  date, sizes, and download URLs — so **new releases appear with no code change here**.
- Falls back to a hardcoded last-known release (`FALLBACK` in the script) if the API is
  unreachable, so the page is never blank.
- Light + dark themed (respects OS preference; manual toggle persists to `localStorage`).
- Assets: `assets/chronicle-shot.png` (real screenshot; framed on the **public**
  `ai-session-manager` session — no private names/code). Missing → built-in HTML/CSS mock.
  `assets/og.png` — optional social-share image.

## The docs (`/docs`)

VitePress. `../docs` is the single source of truth (reviewed in the repo, rendered on
GitHub). `scripts/build-content.mjs` copies it into `./docs` (gitignored) at build time and:

- excludes internal-only content (`superpowers/` specs, the PRD);
- rewrites the few links that point outside `docs/` (repo-root files, the PRD) to absolute
  GitHub URLs so nothing 404s on the site.

Edit docs in `../docs`, never in `./docs` (regenerated each build). VitePress is configured
with `base: '/docs/'` and `srcDir: 'docs'`; `scripts/assemble.mjs` places its build under
`dist/docs` and copies the landing (`index.html` + `assets/`) to `dist/` root. Vercel serves
`dist`.

## Translations (i18n)

The docs ship in **English (`/docs`), 简体中文 (`/docs/zh`), and 日本語 (`/docs/ja`)** — a
language switcher is configured via `locales` in `.vitepress/config.mjs` (with translated
nav/sidebar labels + UI strings). Content lives in `../docs`:

- `../docs/*` — **English, the source of truth.** The changelog page is generated from the
  repo's `CHANGELOG.md` at build time.
- `../docs/zh/**`, `../docs/ja/**` — committed translations, mirroring the English structure.
  `<Walkthrough />` localizes its own captions (see the component).

> **Maintenance:** English is authoritative. When you edit an English page, the `zh`/`ja`
> counterparts **drift until re-translated** — update `docs/<lang>/<same-path>.md` (and, for a
> release, `docs/zh/changelog.md` + `docs/ja/changelog.md`). Keep code, paths, links, and
> product names verbatim across all three.

## Local development

```bash
npm install
npm run docs:dev   # content copy + VitePress dev server → http://localhost:5173/docs/
npm run build      # content copy + vitepress build + assemble → dist/  (landing + docs)
```

Preview just the landing without a build: `python3 -m http.server 4321 --directory website`.
For a faithful combined preview (clean URLs, headers), rely on the Vercel **preview**
deployment (`npm run deploy:preview`) — a plain static file server won't resolve clean URLs.

## Deploying (Vercel CLI)

Hosted on Vercel under the `chizhangucb` scope, one project for the whole site. A
`website/`-rooted CLI deploy only uploads this folder (not `../docs`), so the docs content is
generated **locally** first and uploaded; Vercel then runs `npm run build:site`
(`vitepress build` + assemble). The `deploy` scripts wire this together:

```bash
npm run deploy:preview   # content copy + `vercel`        → unlisted preview URL
npm run deploy           # content copy + `vercel --prod` → production
```

First-time setup links the local dir to the Vercel project (`chronicle-web` owns the
`getchronicle.dev` domain and serves both the landing and the docs):

```bash
vercel link --project chronicle-web --yes
```

> **Deploy production from `main`.** Like the other singletons in this repo (the relay, the
> release tag, the live domain), the site should track `main`. After a PR merges:
> `git checkout main && git pull && cd website && npm run deploy`.

### Automatic deploys (GitHub Actions)

You normally don't need to deploy by hand: [`.github/workflows/deploy-docs.yml`](../.github/workflows/deploy-docs.yml)
redeploys production on every push to `main` that touches `docs/**`, `CHANGELOG.md`, or
`website/**`. It runs the same `npm run content` + `vercel --prod` this runbook describes, so
a merged docs/changelog change reaches getchronicle.dev on its own. The manual `npm run deploy`
stays as a fallback (and the workflow can be run on demand from the **Actions** tab).

**One-time setup:** add a `VERCEL_TOKEN` repository secret (Vercel → Account Settings → Tokens →
Create, then `gh secret set VERCEL_TOKEN --repo chizhangucb/chronicle`). The org/project IDs the
CLI needs are inlined in the workflow (they're identifiers, not secrets).

### Changelog translations (auto)

`scripts/translate-changelog.mjs` (called by `npm run content`) keeps the zh/ja changelog in
sync automatically. For each version, it uses the committed `docs/<lang>/changelog.md` block if
one exists, and otherwise translates the English entry on the fly via **OpenRouter** (free
`nvidia/nemotron-3-ultra-550b-a55b:free`). Set an **`OPENROUTER_API_KEY`** repo secret to enable
it (`gh secret set OPENROUTER_API_KEY --repo chizhangucb/chronicle`); without the key, or if the
API call fails, a new version falls back to English with a "translation pending" note and the
build still succeeds. Committed translations always win, so hand-editing `docs/zh|ja/changelog.md`
for quality still works — it's just no longer required before a release.

## Domain & DNS

Production domain: **`getchronicle.dev`** (apex) + `www.getchronicle.dev`, on the site's Vercel
project. `relay.getchronicle.dev` (feedback relay) is a **separate** project and is untouched.

DNS is at **Porkbun**. Point the apex at Vercel with one record — it coexists with the existing
`MX`/Resend records, so `feedback@getchronicle.dev` keeps working:

| Type | Host | Value |
| --- | --- | --- |
| `A` | `@` (apex) | `76.76.21.21` |
| `CNAME` | `www` | `cname.vercel-dns.com` |

Add via the Porkbun DNS console (it can hang in browser automation — enter records by hand).
Then verify the domain in Vercel (`vercel domains inspect getchronicle.dev`); TLS is automatic.
Verify with `dig getchronicle.dev` and a live load of `/` and `/docs`.
