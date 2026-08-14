# Chronicle product contract

> **Change rule.** This file changes ONLY with Chi's explicit sign-off. A PR that touches
> product shape (a route, a surface's block/card inventory, the sidebar set, an enumerable
> below) WITHOUT a matching edit to this file plus a sign-off note in the PR description is
> **drift by definition** — the release-walk conformance lens fails it and publish is blocked
> (IA drift = P0). "Sign-off note" = one line naming Chi's confirmation (brainstorm/message/
> live call) for the shape change.

The agreed product shape as enumerable, checkable facts — reflecting the CURRENT
(post-F1/F2) branch state, which is Chi's latest confirmed calls. Where this disagrees with
the spec (`~/chizhang-2/records/plans/2026-08-12-chronicle-quality-pass-design.md`), the branch
state wins (F1/F2 fixed the surfaces to Chi's confirmed shape after the plan compressed it).
This is JUDGE input, a sibling of `.claude/design-rubric.md`: the rubric judges *aesthetics/
layout*, this judges *product shape / IA*. Every statement is verifiable against `src/` on this
branch. Each enumerable names the e2e pin that guards it, so the contract is self-auditing.

## Routes & surfaces

| Route | Surface | Component |
|---|---|---|
| `/` | The ONE Insights hub (Home) — tabs Overview / Explore / Content | `src/HomeDashboard.tsx` |
| `/projects` | Dense rail-style project list | `src/ProjectsPage.tsx` |
| `/project/:id` (`/explore`, `/content`) | Project analytics — Overview / Explore / Content / Sessions | `src/ProjectDetail.tsx` |
| `/session/:id` | Session view — Overview / Playback / Refine + Security Check | `src/SessionView.tsx` |
| `/insights` | **Redirect only** → `/` (preserves a `?tab=` deep-link: `/insights?tab=explore` → `/?tab=explore`) | `src/App.tsx` |

- There is exactly ONE Insights surface. Home IS the Insights hub — no separate Insights page,
  no second KPI strip, no duplicate `/api/insights` fetch. `InsightsPage.tsx` was DELETED in the
  Home/Insights merge (F1); its Overview body now lives inline in `HomeDashboard.tsx`, its
  Explore/Content bodies are the shared `ExploreTab.tsx`/`ContentTab.tsx` at `scope={all}`.
- `/` default tab = Overview; the bare `/` carries no `?tab=` param. Explore/Content are
  `?tab=explore` / `?tab=content`.

## Sidebar (`src/App.tsx`)

Exactly ONE collapsible left sidebar; collapse state persists in `localStorage`; width is
drag-resizable when expanded. Contents, top to bottom:

- **Brand** — `◷` Chronicle (click → `/`).
- **`sb-top` nav — exactly two items:** Home (`⌂`) and Projects (`◫`). NO Insights entry, no
  `∑` glyph in the sidebar. Projects highlights across every project-scoped route (`/projects`,
  `/project/:id[/explore|/content]`, `/session/:id`) but NOT on Home.
- **Session modes** — appear in `sb-top` ONLY while a session is open, published up from
  `SessionView` via `onRailChange`: Overview (`⬚`, ⌘1) · Playback (`▶`, ⌘2) · Refine (`✂`, ⌘3) ·
  Security Check (`◈`). The Subagents drill-in is reached only via the Overview Subagents card,
  never the rail.
- **`sb-bottom` util** — Settings (`⚙`) · Feedback (`⊞`, link to GitHub issues) · Collapse
  toggle (`⟨`/`⟩`).

## Topbar (`src/App.tsx`, every route)

- Sync pill (`useSyncStatus`: "synced Xm ago" / "syncing…" / "sync failed"; click = sync now) —
  on EVERY page.
- LIVE pill — session-scoped ONLY (renders only when `atSession` and a live SSE stream is open).
- Search (`⌕`, ⌘K) · "+ Import Sessions" · language dropdown (EN / 中文 / 日本語) — all every-route.
- NO "← Projects" back link anywhere (real URL routes; browser back/forward).

## Enumerables (exact sets — changing any is a contract edit)

- **Window toggle** (`/` hub `.rangebar`): `Today` · `7d` · `30d` · `90d` · `All`. Exactly five,
  in this order. Default = Today. Today = fractional-days-since-local-midnight; All = no cutoff.
- **Hub tabs** (`/`): `Overview` · `Explore` · `Content`. Exactly three; Overview default.
- **Project tabs** (`/project/:id`): `Overview` · `Explore` · `Content` · `Sessions`.
- **Session modes rail**: `Overview` · `Playback` · `Refine` + `Security Check` (four rail items).
- **Search palette scopes** (`src/SearchModal.tsx` `.search-tabs`): `All` · `Tools` · `Chat`.
  Exactly three. The tool-call scope is labeled **"Tools"**, NEVER "Code" (code = tool_use/
  tool_result; chat = user/assistant/thinking). Plus a time filter and a project filter.
- **Project gear menu** (`ProjectMenu`, `/projects` rows): `Sync Update` · `Rename` · `Remove
  from Chronicle`. Exactly these three actions. NO "View Details" (the row itself navigates).
  Every destructive/text step is an inline affordance — never `window.confirm/prompt/alert`.
- **Glyph vocabulary** (mono only, zero colored emoji in chrome or page content; canonical set in
  `.claude/design-rubric.md`): `⌕`=search `⧖`=time `◫`=project `▤`=chat/session
  `⬚`=session-Overview-mode (sidebar only) `◈`=security `⚙`=settings `⌫`=destructive `✕`=close
  `⌂`=Home `⊞`=feedback `◷`=brand `⎇`=git branch. `∑`=insights is retired from chrome (no
  Insights sidebar item). Per-surface: `/` hub tabs are text; `/projects` rows use `⎇`/`⚙`;
  session rail uses the mode glyphs above.
  - **Known tracked gap (NOT a novel finding):** `src/kinds.ts` `KIND_ICON` still maps
    `user`/`thinking`/`tool_use` to colored emoji (👤/💭/🔧) in Playback rows — adjudicated at
    the walk, per the rubric.

## Per-surface content inventory (what each surface MUST show)

### `/` Overview tab — reading order is load-bearing (top → bottom)

1. **KPI strip** (`.kpis`, `KpiStrip`) — headline tiles from one `/api/insights` fetch: Spend ·
   Sessions · Tokens · Agent active (InfoTip) · Your engaged (InfoTip, shows leverage) · Tool
   calls (InfoTip) · Error rate (InfoTip) · Commits, plus a conditional **Proxy lane (billed)**
   tile shown only when the LiteLLM lane has spend in range.
2. **Activity block** (`.activity-card`, `ActivityBlock`) — **Today window ONLY** (absent on
   7d/30d/90d/All). Two groups: "Live now" + "Since you left". Each row: live-dot · session name ·
   project · error count (if > 0) · when (live / relative ended-at) · cost.
3. **Burn tile** (`.burn-card`, `BurnTile`) — window spend vs a baseline (Today → 14-day daily
   median; 7d/30d/90d → prior period of the same length; All → NO baseline). Warn tint + `×ratio`
   + "high" flag when spend runs > 2× baseline. Comparison bar when a baseline exists. Names the
   top contributing session (name + cost), clickable.
4. **Insights charts** (`.grid2` then `.grid2b` etc., `InsightsCharts`) — Spend over time stacked
   by project (top 5 + neutral "Other") · Spend by model · Sources · Working Rhythm · Global tool
   mix (top 5 + Other) · Error rate by project · Token usage by model table · Top sessions by cost.
5. **Recent-sessions ledger** (`.recent-ledger`, `RecentLedger`) — LAST. Filter search box,
   "Recent sessions" title, "Select minor sessions (N)" quick-select, day-grouped rows (day-header
   tri-state checkbox in select mode), infinite lazy scroll, minor-sessions bucket.

The Explore / Content tabs render `ExploreTab` / `ContentTab` at `scope={all}` (same components
the project view uses per-project).

### `/projects` — dense rail-list, NOT a card grid

- Rows are `.rail-proj` (the pre-Batch-C sidebar-rail row anatomy laid out as a page), NEVER the
  bordered `.projects-grid` card treatment (F2 removed that unagreed redesign; `.projects-grid`
  must never exist again).
- Row: colored `.pdot` · project name · optional live-dot (when a session in the project is live)
  … session count (`.c`) · gear menu (`⚙`). Meta line: branch (`⎇ <branch>`) or "needs
  association" · relative last-active time.
- No permanent border/background (base `border: 1px solid transparent`, visible on hover only).
- Reflow: single column below 1400px, two columns at ≥ 1400px (`styles.css` `@media (min-width:
  1400px)`; pinned by e2e at the 1024 / 1728 reference widths).
- Row click → project analytics; gear menu → the enumerable above.

### `/project/:id` — Overview / Explore / Content / Sessions tabs (`ProjectDetail.tsx`).
### `/session/:id` — Overview / Playback / Refine / Security Check (`SessionView.tsx`); Subagents card on Overview.

## Pin inventory (each enumerable → its guarding e2e test — the contract self-audits)

| Enumerable / shape fact | Guarding test |
|---|---|
| Sidebar = exactly Home + Projects, no Insights, no `∑` | `test/e2e/home.spec.ts` — "sidebar top nav has exactly Home and Projects" |
| Hub tabs = Overview / Explore / Content, Overview default | `test/e2e/home.spec.ts` — "the hub at / shows Overview / Explore / Content tabs" |
| Window toggle = Today / 7d / 30d / 90d / All (exactly five) | `test/e2e/home.spec.ts` — "the window toggle on / has exactly…" |
| `/insights` (and `?tab=`) redirects to `/` | `test/e2e/home.spec.ts` — "/insights redirects…" + "…?tab=explore…" |
| Overview DOM order KPIs → activity → burn → charts → ledger | `test/e2e/home.spec.ts` — "Overview reading order…" |
| Activity block Today-only; Burn tile persists on 7d | `test/e2e/home.spec.ts` — "window toggle to 7d hides the Activity block…" |
| Live dot in the Activity block | `test/e2e/home.spec.ts` — "live session shows a pulsing dot…" |
| `/projects` = rail-list, no `.projects-grid`, not a card | `test/e2e/projects.spec.ts` — "renders rail-style rows…", "…NOT a bordered card…" |
| Project gear menu = Sync Update / Rename / Remove, no View Details | `test/e2e/projects.spec.ts` — "gear menu opens with…"; `chrome.spec.ts` T17.6 |
| `/projects` reflow 1-col ≤1024 / 2-col ≥1728, no overflow | `test/e2e/projects.spec.ts` — "list is single-column…", "no horizontal overflow…" |
| Project-row live dot | `test/e2e/projects.spec.ts` — "live session shows a pulsing dot on its project row" |
| Search scopes = All / Tools / Chat (exactly three, never "Code") | `test/e2e/chrome.spec.ts` T17.8 |
| Topbar sync indicator on every page (click = sync now) | `test/e2e/chrome.spec.ts` T17.1 |
| No "← Projects" back link anywhere | `test/e2e/chrome.spec.ts` T17.2 |
| Session Overview live dot | `test/e2e/chrome.spec.ts` T17.3 |
| Labeled Rename affordance (Chronicle-scope InfoTip) | `test/e2e/chrome.spec.ts` T17.4 |
| Home ledger multi-select / inline confirm (no native dialog) | `test/e2e/select.spec.ts` |
| Home ledger column policy (num-col / ts-col alignment) | `test/e2e/layout.spec.ts` |
| Subagents card = run count (120) on the big fixture | `test/e2e/smoke.spec.ts` — "…Subagents card shows the run count (120)" |
| Explore session grouping / Other segment | `test/e2e/explore.spec.ts` |
| Content 7 characteristics | `test/e2e/content-characteristics.spec.ts` |
| Playback selection drives panels | `test/e2e/playback.spec.ts` |
| InfoTip opens downward, closes, no viewport clip | `test/e2e/infotip.spec.ts` |
