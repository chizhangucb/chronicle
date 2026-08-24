# Chronicle product contract

> **Change rule.** This file changes ONLY with Chi's explicit sign-off. A PR that touches
> product shape (a route, a surface's block/card inventory, the sidebar set, an enumerable
> below) WITHOUT a matching edit to this file plus a sign-off note in the PR description is
> **drift by definition** — the release-walk conformance lens fails it and publish is blocked
> (IA drift = P0). "Sign-off note" = one line naming Chi's confirmation (brainstorm/message/
> live call) for the shape change.

The agreed product shape as enumerable, checkable facts — reflecting the CURRENT
(post-F1/F2, post-2026-08-14-feedback-round-D1/D2/D14) branch state, which is Chi's latest
confirmed calls. Where this disagrees with
the spec (`~/chizhang-2/records/plans/2026-08-12-chronicle-quality-pass-design.md`), the branch
state wins (F1/F2 fixed the surfaces to Chi's confirmed shape after the plan compressed it).
This is JUDGE input, a sibling of `spec/design-qa-rubric.md`: the rubric judges *aesthetics/
layout*, this judges *product shape / IA*. Every statement is verifiable against `src/` on this
branch. Each enumerable names the e2e pin that guards it, so the contract is self-auditing.

## Routes & surfaces

| Route | Surface | Component |
|---|---|---|
| `/` | The ONE Insights hub, sidebar item **`∑ Insights`** — tabs Overview / Explore / Content | `src/HomeDashboard.tsx` |
| `/projects` | Chrome-sidebar layout, no h1: a CENTER content column (filter toolbar, shared select command bar, "Recent sessions" ledger — stacks first below 1100px) + a RIGHT chrome sidebar (same tone as the left app sidebar, full height, flush to the window edge >=1100px; eyebrow `PROJECTS · N`, borderless nav rows, gear visible at rest) | `src/ProjectsPage.tsx` |
| `/project/:id` (`/explore`, `/content`) | Project analytics — Overview / Explore / Content / Sessions | `src/ProjectDetail.tsx` |
| `/session/:id` | Session view — Overview / Playback / Refine + Security Check | `src/SessionView.tsx` |
| `/insights` | **Redirect only** → `/` (preserves a `?tab=` deep-link: `/insights?tab=explore` → `/?tab=explore`) | `src/App.tsx` |

- There is exactly ONE Insights surface, at `/` — no separate Insights page, no second KPI strip,
  no duplicate `/api/insights` fetch. `InsightsPage.tsx` was DELETED in the Home/Insights merge
  (F1); its Overview body now lives inline in `HomeDashboard.tsx`, its Explore/Content bodies are
  the shared `ExploreTab.tsx`/`ContentTab.tsx` at `scope={all}`. The surface (and its sidebar
  item) is labeled **Insights**, not "Home" (D2, Task 9).
- `/` default tab = Overview; the bare `/` carries no `?tab=` param. Explore/Content are
  `?tab=explore` / `?tab=content`.

## Sidebar (`src/App.tsx`)

Exactly ONE collapsible left sidebar; collapse state persists in `localStorage`; width is
drag-resizable when expanded. Contents, top to bottom:

- **Brand** — `◷` Chronicle (click → `/`).
- **`sb-top` nav — exactly two items:** Insights (`∑`) and Projects (`◫`). NO Home entry, no
  `⌂` glyph in the sidebar — the hub at `/` is labeled **Insights** everywhere (sidebar item
  title, `/` page title), never "Home" (per Chi, 2026-08-14 feedback round, D2 —
  `records/plans/2026-08-14-chronicle-feedback-round-plan.md`; pixels checkpoint before merge
  on PR). Projects highlights across every project-scoped route (`/projects`,
  `/project/:id[/explore|/content]`, `/session/:id`) but NOT on the Insights hub.
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
- **Cost basis toggle** (`.cost-mode-toggle`, `CostModeToggle`, every route): two options,
  `List price` (theoretical, default) vs `Billed` (real). Global state (`src/costMode.tsx`,
  persisted); every cost figure across the app prices at the selected mode. `List price` = metered
  list price; `Billed` = what Chi pays, so subscription-covered models (Claude tiers, gpt-5.6 /
  Codex) read ~$0. The active mode is ALWAYS visibly labeled next to spend figures so no number
  silently changes meaning.
- Search (`⌕`, ⌘K) · "+ Import Sessions" · language dropdown (EN / 中文 / 日本語) — all every-route.
- NO "← Projects" back link anywhere (real URL routes; browser back/forward).

## Enumerables (exact sets — changing any is a contract edit)

- **Window toggle** (`/` hub `.rangebar`): `Today` · `7d` · `30d` · `90d` · `All`. Exactly five,
  in this order. Default = Today. Today = fractional-days-since-local-midnight; All = no cutoff.
- **Project rangebar** (`/project/:id` `.project-detail .rangebar`): `Today` · `7d` · `30d` ·
  `90d` · `All`. Same exact five, same order, same labels as the hub window toggle above — ONE
  shared vocabulary, sourced from ONE component (`src/RangeBar.tsx`) both surfaces mount, so the
  option sets/labels cannot drift independently again. Default = All (unchanged from before this
  unification — only the vocabulary/labels changed, not the default). **D10 sign-off (2026-08-14
  feedback round, Task 17): Chi approved unifying ProjectDetail's prior
  `Today`/`7 Days`/`30 Days`/`1 Year`/`All time` set onto the hub's `Today`/`7d`/`30d`/`90d`/`All`
  — `1 Year` is REMOVED (90d replaces it), `All time` → `All`.** Guard:
  `test/e2e/window-matrix.spec.ts` — "the rangebar on /project/:id has exactly the same Today /
  7d / 30d / 90d / All set as the / hub".
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
  `spec/design-qa-rubric.md`): `⌕`=search `⧖`=time `◫`=project `▤`=chat/session
  `⬚`=session-Overview-mode (sidebar only) `◈`=security `⚙`=settings `⌫`=destructive `✕`=close
  `∑`=insights (the sidebar Insights item) `⊞`=feedback `◷`=brand `⎇`=git branch. `⌂`=Home is
  retired from chrome — the sidebar item it used to label was renamed to `∑ Insights` (D2, see
  above); `⌂` does not appear anywhere in `src/`. Per-surface: `/` hub tabs are text;
  `/projects` rail rows use `⎇`/`⚙`; session rail uses the mode glyphs above.
  - **Known tracked gap (NOT a novel finding):** `src/kinds.ts` `KIND_ICON` still maps
    `user`/`thinking`/`tool_use` to colored emoji (👤/💭/🔧) in Playback rows — adjudicated at
    the walk, per the rubric.

## Per-surface content inventory (what each surface MUST show)

### `/` Overview tab — reading order is load-bearing (top → bottom)

1. **KPI strip** (`.kpis`, `KpiStrip`) — headline tiles from one `/api/insights` fetch: Spend ·
   Sessions · Tokens · Agent active (InfoTip) · Your engaged (InfoTip, shows leverage) · Tool
   calls (InfoTip) · Error rate (InfoTip) · Commits, plus a conditional **Proxy lane (billed)**
   tile shown only when the LiteLLM lane has spend in range.
   - **Spend** carries a visible mode label (`list price` / `billed ~$0 under subscription`) and a
     sub-line breaking out the automation portion (`incl. $X automation`). The total INCLUDES
     automation spend (broken out, never hidden).
   - **Sessions** is the INTERACTIVE count only (headless automation excluded) and carries a
     visible sub-label `N automation excluded` plus an InfoTip. Automation sessions come from the
     `~/.aios/machine_sessions.jsonl` manifest (weekly/nightly/session-close/spend-advice jobs),
     bucketed by job; a manifest session whose transcript is also imported is counted once, as
     automation (transcript wins, never double counted).
2. **Activity block** (`.activity-card`, `ActivityBlock`) — **Today window ONLY** (absent on
   7d/30d/90d/All). Two groups: "Live now" + "Since you left". Each row: live-dot · session name ·
   project · error count (if > 0) · when (live / relative ended-at) · cost.
3. **Burn tile** (`.burn-card`, `BurnTile`) — window spend vs a baseline (Today → 14-day daily
   median; 7d/30d/90d → prior period of the same length; All → NO baseline). Warn tint + `×ratio`
   + "high" flag when spend runs > 2× baseline. Comparison bar when a baseline exists. Names the
   top contributing session (name + cost), clickable. **D6 sign-off (feedback-round Task 13,
   `records/plans/2026-08-14-chronicle-feedback-round-plan.md`):** the headline (`.burn-now .v`) IS
   the ratio + flag (e.g. `×3.2 high`) when a baseline exists; the support line (`.burn-now .s`) is
   the absolute comparison, `$current vs $baseline · <baselineLabel>`. (No-baseline `All` case
   unchanged: headline falls back to absolute spend, support line stays "all time · no baseline".)
4. **Insights charts** (`.grid2` then `.grid2b` etc., `InsightsCharts`) — Spend over time stacked
   by project (top 5 + neutral "Other") · Spend by model · Sources · Working Rhythm · Global tool
   mix (top 5 + Other) · Error rate by project · Token usage by model table · Top sessions by cost.
   **LAST** — the Overview tab ends here. The recent-sessions ledger does NOT mount on `/` (moved
   off in Task 9, D1 — see `/projects` below; per Chi, 2026-08-14 feedback round, D1+D2,
   `records/plans/2026-08-14-chronicle-feedback-round-plan.md`; pixels checkpoint before merge on
   PR).

The Explore / Content tabs render `ExploreTab` / `ContentTab` at `scope={all}` (same components
the project view uses per-project).

### `/projects` — chrome-sidebar: content column (center) + chrome rail (right)

PR-2c reshape (Task 20, D14 — Chi's SECOND checkpoint reply, superseding the PR-2 two-column
"card-ish rail" shape below): "recent sessions and projects should not be seen as exactly at the
same data model level… I was wondering if the old design of adding projects as a sidebar on the
right side, similar to the left-side home sidebar, is gonna make this better" — Chi picked the
CHROME SIDEBAR mockup. Three vertical zones: the left app sidebar (`src/App.tsx`, untouched), a
CENTER content column (`.projects-content`), and a RIGHT chrome sidebar (`.right-rail`). No page
`h1` (still true post-PR-2c — redundant next to the sidebar nav, which already names the page).
D1 VERBATIM still holds: the ledger, not the project list, is the primary/moving-list surface —
it lives in the content column and stacks first at every width (below).

- **CENTER content column** (`.projects-content`, scrolls independently of the chrome rail at
  ≥1100px) — top to bottom: the filter toolbar (`.home-search`, scoped to the content column's own
  width, NOT spanning under the chrome rail — supersedes PR-2's "spans both columns" shape now
  that the right side is chrome, not a second content column), then the shared select command bar
  when either list is selecting (below), then `RecentLedger` (`.recent-ledger`) unchanged in its
  own logic: "Recent sessions" title + one small "☑ Select" affordance (only at rest — hidden while
  selecting), then (when any minor sessions exist, recent mode only) a visible `.minor-filter-notice`
  callout at the TOP of the ledger naming the count hidden by the noise gate + an InfoTip stating the
  exact gate definition; "Show them" expands the minor sessions INLINE in place (promote/ignore per
  row) — there is NO separate minor-sessions section at the bottom of the ledger (removed 2026-08-16,
  Chi-approved: the bottom bucket forced a long scroll and read as broken). Then day-grouped rows
  (day-header tri-state checkbox in select mode), infinite lazy scroll. Noise gate: a session is
  "minor" only when short on BOTH axes (agent-active under threshold AND messages under threshold —
  AND, not OR), so substantive sessions are never hidden on one axis alone.
- **Scrollbars** — app-wide always-visible thin scrollbars (`::-webkit-scrollbar` styled in
  Chromium/Safari to force classic non-overlay bars; `scrollbar-width`/`-color` scoped to Firefox via
  `@supports not selector(::-webkit-scrollbar)` so it doesn't disable the webkit pseudo-elements).
  The center content column and right rail must show a scrollbar at rest when overflowing, not only
  on hover. Guard: `test/e2e/projects.spec.ts` (scroll container reserves classic-scrollbar layout width).
- **RIGHT chrome sidebar** (`.right-rail`, ≥1100px only — see Reflow below) — same background tone
  and typography family as the LEFT app sidebar (`.sidebar`; the e2e pin checks computed-background
  equality, not a hardcoded hex), full height, flush to the window's right edge, own independent
  scroll. Head (`.right-rail-head`): an eyebrow-style label `PROJECTS · N` (same recipe as the left
  sidebar's `.sb-sec-head.eyebrow` "SESSION" label) + one small "☑ Select" affordance (only at
  rest). Below it, the dense project list — rows are `.rail-proj` (the pre-Batch-C sidebar-rail row
  anatomy), NEVER the bordered `.projects-grid` card treatment (F2 removed that unagreed redesign;
  `.projects-grid` must never exist again) and NEVER a table (no `.colhead`/`<th>` — this is
  navigation). Row: colored `.pdot` · project name · optional live-dot (when a session in the
  project is live) … session count (`.c`) · gear menu (`⚙`). Meta line: branch (`⎇ <branch>`) or
  "needs association" · relative last-active time. No permanent border/background (base
  `border: 1px solid transparent`, visible on hover only) unless selected (checkbox + subtle tint,
  see multi-select below — NO brass border on a selected row anymore, PR-2c killed that).
- **Gear rests visible** (Task 19, PR-2 checkpoint, unchanged by PR-2c): `.rail-proj .gear` sits at
  a muted `opacity: .45` at rest, full opacity on row hover/focus or while a sync spins.
- **ONE shared full-width command bar for BOTH select flows** (PR-2c, Task 20) — entering select
  mode on EITHER list (the ledger's own "☑ Select", or the chrome rail's own "☑ Select") slides ONE
  `.command-bar` in directly under the filter toolbar, in the content column (`.projects-content >
  .command-bar`). The two flows are MUTUALLY EXCLUSIVE — entering one force-exits the other — so
  the bar only ever shows one at a time:
  - **Sessions**: `<N> sessions selected · Select all/Clear · Cancel · [chip: Select minor
    sessions (N), sessions-only — moved OUT of the ledger's resting header] · ⌫ Remove (N)`, the
    existing `useSessionSelect` flow (two-step inline confirm, never `window.confirm`, 10s Undo
    toast, tombstone + re-sync) — unchanged logic, only its rendering location moved (it now
    portals into the command bar instead of a boxed `.select-toolbar` inside the ledger).
  - **Projects**: `<N> projects selected · Select all/Clear · Cancel · ⟳ Sync (N) (immediate,
    spinner, sequential per project) · ⌫ Remove (N)` (two-step inline confirm, no undo — matches
    the existing single-project gear-menu remove, since `deleteProject` hard-deletes rather than
    tombstones).
  - The OLD in-ledger boxed toolbar and the OLD in-rail boxed toolbar are both REMOVED —
    `.select-toolbar` no longer appears anywhere on `/projects` (it still exists as a class, used
    only by the unrelated ProjectDetail Sessions-tab select flow).
- **Reflow** (`styles.css` `.projects-page`, `@media (min-width: 1100px)`): below 1100px the right
  sidebar LEAVES THE CHROME — it renders as a boxed "Projects" section (real border, `.right-rail`'s
  boxed-card styling) BELOW the ledger, in normal page flow (`.projects-page` itself is the single
  scroll container at this width, same as any other page) — ledger stays first (D1/D13). At
  ≥1100px, `.projects-page` hands its own padding/scroll off to its two children so the rail can
  reach true full height flush to the viewport edge — `.projects-content` (flex 1, own
  `overflow-y: auto`) left, `.right-rail` (`flex: 0 0 280px`, own `overflow-y: auto`) right.
- Ledger row click → session view; rail row click (outside select mode) → project analytics; rail
  gear menu → the enumerable above.

Sign-off: per Chi, 2026-08-14 second checkpoint reply (D14,
`records/plans/2026-08-14-chronicle-feedback-round-plan.md`) — supersedes the PR-2 checkpoint
sign-off (D13) for this surface's shape.

### `/project/:id` — Overview / Explore / Content / Sessions tabs (`ProjectDetail.tsx`).
### `/session/:id` — Overview / Playback / Refine / Security Check (`SessionView.tsx`); Subagents card on Overview.

**D3 sign-off (feedback-round Task 11, `records/plans/2026-08-14-chronicle-feedback-round-plan.md`
— addendum to the original C3 Subagents-card decision).** The Overview **Subagents** card
(`.subagent-row` rows) header stays `Subagents · <N>` where N is the whole-session run count
(distinct `agent_id`, NOT distinct agent_type — the permanent data-scale guard, see the pin
inventory). Each row reads `<agent_type> · N run(s) · <tokens> tok` (an `InfoTip` explains
runs-vs-turns-vs-tokens). Drill-in is **two levels**, reached only from this card (never the
sidebar rail):
1. **Level 1 — click a type row** → a run-list table (`.rowlink` rows, columns Start / Duration /
   Turns / Tokens / Description) listing every run (`agent_id`) of that `agent_type`, sorted by
   start time.
2. **Level 2 — click a run row** → that run's transcript (`.subagent-conv`), filtered to
   `agent_id` (not the whole type — each run's messages render on their own, not interleaved with
   sibling runs of the same type).
Back affordances step back one level at a time (run transcript → run list → session Overview).

### Content tab — composition + three-card grid (D5, D7)

**D5/D7 sign-off (feedback-round Task 14, `records/plans/2026-08-14-chronicle-feedback-round-plan.md`).**
- **D5 — token composition rows sort DESC by token count** (`compositionRows`, zero-token rows
  sink to the bottom); each kind's bar color is stable (keyed to a fixed kind order), not
  positional, so it doesn't reshuffle as the sort order changes. `.grid2`/`.grid2b` card rows use
  `align-items: stretch` so shorter cards fill the row height instead of looking short next to a
  taller sibling.
- **D7 — the old single "Skills & subagents" card (one shared bar-scale `max`) is SPLIT into
  THREE independently-scoped cards** in a `.grid3` row: **Tool results by tool | Skills |
  Subagents**, each capped at 6 rows and each with its OWN bar-scale `max` (kills the empty-bar
  artifact where a short list looked flat under a shared max dominated by a heavier sibling).
  `.grid3` reflows via `auto-fit`/`minmax(200px,1fr)` (3 → 2+1 → 1-per-row) rather than a hardcoded
  breakpoint, so it holds at 1024/1366/1728 without a dedicated media query.

### Content tab (`ContentTab.tsx`, shared by `/` all-scope, `/project/:id`, and session scope)

**D4 sign-off (feedback-round Task 12, Chi approved in
`records/plans/2026-08-14-chronicle-feedback-round-plan.md`).** The old "What your usage says"
narrative callouts card (3 hand-written sentences: context-pressure share, subagent-heavy share,
cache-warmth minutes) and the separate "Usage characteristics" card (7 token-share stats, spec
§2.5) are MERGED into ONE card, titled **"What your usage says"** — the narrative callouts
duplicated numbers the characteristics list already carried (contextPressureShare was literally
highContextRel's share), so their framing now lives in the top rows' `why` text instead of a
second parallel computation; the cache-warmth-minutes stat (not a token share) had no
characteristics-list analog and was dropped.

The characteristics list is now **scope-tagged** (`ContentResult.characteristicsScope` +
per-row `Characteristic.format`/`value`/`value2`/`label`/`why`/`info`, all server-supplied so the
client never switches on a characteristic's `key`):
- **all/project scope: 7 rows** (unchanged math, reordered) — `highContextRel` and
  `subagentTurns` lead (absorbing the old narrative callouts' framing), then
  `eightHourSessions` · `workflowRuns` · `highContextAbs` · `cacheEfficiency` · `autonomousShare`.
- **session scope: 6 rows.** The four threshold predicates that always collapse to a meaningless
  0%/100% at N=1 (`eightHourSessions`, `highContextAbs`, `highContextRel`, `autonomousShare`) are
  REPLACED with absolute session facts: `marathonBadge` (real active hours vs the 8h line),
  `peakContextTokens` (raw tokens + % of the model's window, folding the old abs/rel pair into
  one richer fact), and `unattendedRatio` (engaged ÷ active, not a binary flag).
  `cacheEfficiency` / `subagentTurns` / `workflowRuns` carry over unchanged — real, non-binary
  percentages even for one session.

## Pin inventory (each enumerable → its guarding e2e test — the contract self-audits)

| Enumerable / shape fact | Guarding test |
|---|---|
| Sidebar = exactly Insights + Projects, no Home entry, no `⌂` | `test/e2e/home.spec.ts` — "sidebar top nav has exactly Insights and Projects, no Home entry" |
| Hub tabs = Overview / Explore / Content, Overview default | `test/e2e/home.spec.ts` — "the hub at / shows Overview / Explore / Content tabs" |
| Window toggle = Today / 7d / 30d / 90d / All (exactly five) | `test/e2e/home.spec.ts` — "the window toggle on / has exactly…" |
| `/insights` (and `?tab=`) redirects to `/` | `test/e2e/home.spec.ts` — "/insights redirects…" + "…?tab=explore…" |
| Overview DOM order KPIs → activity → burn → charts, no ledger | `test/e2e/home.spec.ts` — "Overview reading order…" |
| Activity block Today-only; Burn tile persists on 7d | `test/e2e/home.spec.ts` — "window toggle to 7d hides the Activity block…" |
| Live dot in the Activity block | `test/e2e/home.spec.ts` — "live session shows a pulsing dot…" |
| `/projects` chrome-rail rows, no `.projects-grid`, not a card | `test/e2e/projects.spec.ts` — "renders rail-style rows…", "…NOT a bordered card…" |
| Project gear menu = Sync Update / Rename / Remove, no View Details | `test/e2e/projects.spec.ts` — "gear menu opens with…"; `chrome.spec.ts` T17.6 |
| `/projects` recent-sessions ledger is the main content column | `test/e2e/projects.spec.ts` — "recent-sessions ledger is the main content column…" |
| `/projects` right rail = chrome (same bg tone as `.sidebar`, flush to viewport right edge, full height) at ≥1100px | `test/e2e/projects.spec.ts` — "right rail renders as chrome…" |
| `/projects` right rail eyebrow `PROJECTS · N` + Select affordance, no table headers | `test/e2e/projects.spec.ts` — "right rail shows an eyebrow…no table headers" |
| `/projects` filter toolbar scoped to the content column (not spanning under the chrome rail), no page h1 | `test/e2e/projects.spec.ts` — "filter toolbar sits in the content column…" |
| `/projects` gear rests visible (opacity .45), not opacity:0 | `test/e2e/projects.spec.ts` — "project gear rests at a muted-but-visible opacity, not fully hidden" |
| `/projects` project multi-select via the shared command bar: row click toggles, bulk actions = exactly Sync (N) / Remove (N), inline confirm, no brass border on selected rows | `test/e2e/projects.spec.ts` — "project multi-select: Select enters select mode…" |
| `/projects` the two select flows (sessions/projects) are mutually exclusive — ONE command bar | `test/e2e/projects.spec.ts` — "entering session select exits an active project select…" |
| `/projects` reflow: stacked with a BOXED "Projects" section below the ledger <1100px, content-left/chrome-rail-right ≥1100px | `test/e2e/projects.spec.ts` — "stacks the ledger above a BOXED…", "…places the content column left and a chrome rail right…" |
| `/projects` no horizontal overflow at 1024/1366/1728 | `test/e2e/projects.spec.ts` — "no horizontal overflow on /projects…" |
| Project-row live dot | `test/e2e/projects.spec.ts` — "live session shows a pulsing dot on its project row" |
| Search scopes = All / Tools / Chat (exactly three, never "Code") | `test/e2e/chrome.spec.ts` T17.8 |
| Topbar sync indicator on every page (click = sync now) | `test/e2e/chrome.spec.ts` T17.1 |
| No "← Projects" back link anywhere | `test/e2e/chrome.spec.ts` T17.2 |
| Session Overview live dot | `test/e2e/chrome.spec.ts` T17.3 |
| Labeled Rename affordance (Chronicle-scope InfoTip) | `test/e2e/chrome.spec.ts` T17.4 |
| Recent-sessions ledger (`/projects` content column) select-mode controls render in the shared command bar, no old boxed toolbar, inline confirm (no native dialog) | `test/e2e/select.spec.ts` |
| Recent-sessions ledger (`/projects` content column) column policy (num-col / ts-col alignment) | `test/e2e/layout.spec.ts` |
| Subagents card = run count (120) on the big fixture | `test/e2e/smoke.spec.ts` — "…Subagents card shows the run count (120)" |
| Subagents card two-level drill-in (type → run list → per-run transcript filtered by agent_id) | `test/e2e/smoke.spec.ts` — "Subagents card drill-in opens a run list with more than one distinct run" |
| Content composition rows sort DESC by tokens; Tool results/Skills/Subagents split into three independently-scoped cards (D5, D7) | `test/e2e/window-matrix.spec.ts` (comment-level; no dedicated shape assertion beyond `assertContentNonEmpty` — visual conformance judged at the design-QA walk) |
| Burn tile headline = ratio + flag, support line = absolute `$current vs $baseline` (D6) | no dedicated e2e pin (no probe touches `.burn-now` internals); visual conformance judged at the design-QA walk |
| Explore session grouping / Other segment | `test/e2e/explore.spec.ts` |
| Content characteristics: 7 shares at all/project scope, 6 session facts at session scope, merged into one "What your usage says" card (D4) | `test/e2e/content-characteristics.spec.ts` |
| Playback selection drives panels | `test/e2e/playback.spec.ts` |
| InfoTip opens downward, closes, no viewport clip | `test/e2e/infotip.spec.ts` |
