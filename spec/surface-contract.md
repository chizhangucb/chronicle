# Chronicle surface contract

> This file is the frozen product shape / IA: routes, surfaces, sidebar/topbar chrome, the
> enumerable sets, the per-surface content inventory, and the e2e pin table. A sub-contract of
> `spec/product-contract.md`. It is the IA-conformance target the release walk reads (`npm run walk`),
> judged alongside `spec/design-qa-rubric.md`: the rubric judges aesthetics/layout, this judges
> product shape / IA. Every statement is verifiable against `src/`, and each enumerable names the e2e
> pin that guards it, so the contract self-audits.

> **Change rule.** This file changes ONLY with Chi's explicit sign-off. A PR that touches product
> shape (a route, a surface's block/card inventory, the sidebar set, an enumerable below) WITHOUT a
> matching edit here plus a sign-off note in the PR description is **drift by definition**: the
> release-walk conformance lens fails it and publish is blocked (IA drift = P0). "Sign-off note" =
> one line naming Chi's confirmation (brainstorm/message/live call) for the shape change.

## Routes & surfaces

| Route | Surface | Component |
|---|---|---|
| `/` | The ONE Insights hub, sidebar item **`∑ Insights`** — tabs Overview / Explore / Content / Spend / Sessions | `src/HomeDashboard.tsx` |
| `/projects` | Chrome-sidebar layout, no h1: a CENTER content column (filter toolbar, shared select command bar, "Recent sessions" ledger — stacks first below 1100px) + a RIGHT chrome sidebar (same tone as the left app sidebar, full height, flush to the window edge >=1100px; eyebrow `PROJECTS · N`, borderless nav rows, gear visible at rest) | `src/ProjectsPage.tsx` |
| `/project/:id` (`/explore`, `/content`) | Project analytics — Overview / Explore / Content / Sessions | `src/ProjectDetail.tsx` |
| `/session/:id` | Session view — Overview / Playback / Refine + Security Check | `src/SessionView.tsx` |
| `/insights` | **Redirect only** → `/` (preserves a `?tab=` deep-link: `/insights?tab=explore` → `/?tab=explore`) | `src/App.tsx` |
| `/safety` | **Ops surface (hub-conditional).** A descriptive read of the connected hub's egress/safety posture + controls over the hub's gate-config surfaces (every one of which cards, always) + the write log: every gate write, newest first, with Undo. Same hub-conditional gating as the other ops surfaces. | `src/SafetyPage.tsx` |
| `/reference` | **The unified reference. NOT hub-conditional** (product vocabulary, not hub data), so a stock public install has it. Every metric and term on the console, rendered from `src/reference/definitions.ts`, the SAME registry every `<InfoTip def=...>` reads, so the page cannot drift from the surfaces. Search box + `page`-grouped definition list in the `.card`/`.eyebrow` grammar; each entry is deep-linkable (`/reference#def-<id>`) and each InfoTip carries a `full definition →` link to its own anchor. Ends with a **`Retired`** group holding definitions for surfaces that were dropped (pinned panels, peek drill, the old burn tile, and the whole Memory vocabulary retired by the shrink). | `src/ReferencePage.tsx` |
| `/ask` | **Ask: NOT hub-conditional — gated on the Settings `ask` toggle AND the claude CLI being present AND a non-demo console, all decided server-side by `/api/ask/status` (`enabled = toggleOn && claudePresent && !demo`).** One conversation column: eyebrow `ASK`, day dividers, right-aligned questions, answer cards (prose + full-width result table + `SQL ▸` expander + cost-basis label + a `re-ask under {other basis}` action), a bottom input bar, and a "nothing leaves your machine" footer. Durable local history at `~/.chronicle/ask-history.jsonl` (newest 500). Each answer is produced by an operator-initiated local `claude -p` spawn confined to EXACTLY ONE tool — a read-only, SELECT-only query server over `chronicle.db` (`--tools "" --allowedTools mcp__chronicledb__query --strict-mcp-config`; the read-only handle is the hard guarantee). Dollar figures use the two deduped cost surfaces (`session_model_cost` reconciles with the Insights dashboards) so `/ask` never contradicts the dashboards. Renders the page ONLY when enabled; otherwise the route fails soft (a "not available" message). Demo refuses `POST /api/ask` with 409 like every runner. | `src/AskPage.tsx` |

- There is exactly ONE Insights surface, at `/` — no separate Insights page, no second KPI strip,
  no duplicate `/api/insights` fetch. There is no `InsightsPage.tsx`; the Overview body lives inline
  in `HomeDashboard.tsx`, the Explore/Content bodies are the shared `ExploreTab.tsx`/`ContentTab.tsx`
  at `scope={all}`. The surface (and its sidebar item) is labeled **Insights**, never "Home".
- `/` default tab = Overview; the bare `/` carries no `?tab=` param. Explore/Content are
  `?tab=explore` / `?tab=content`.

## Sidebar (`src/App.tsx`)

Exactly ONE collapsible left sidebar; collapse state persists in `localStorage`; width is
drag-resizable when expanded. Contents, top to bottom:

- **Brand** — `◷` Chronicle (click → `/`).
- **`sb-top` nav — two ALWAYS-ON items:** Insights (`∑`) and Projects (`◫`). NO Home entry, no
  `⌂` glyph in the sidebar — the hub at `/` is labeled **Insights** everywhere (sidebar item
  title, `/` page title), never "Home". `⌂` does not appear anywhere in `src/`. Projects highlights
  across every project-scoped route (`/projects`, `/project/:id[/explore|/content]`, `/session/:id`)
  but NOT on the Insights hub.
- **`sb-top` ops nav — hub-conditional.** After Projects, the ops items render ONLY when
  `/api/hub/status` reports present (live or demo); ALL hidden when the hub is absent, in order:
  **Safety (`⊘`)**. So on a stock public install with no hub, `sb-top` is exactly Insights +
  Projects; with a hub or in demo it also carries the ops items. See the "ops routes are
  hub-conditional" enumerable below.
- **Session modes** — appear in `sb-top` ONLY while a session is open, published up from
  `SessionView` via `onRailChange`: Overview (`⬚`, ⌘1) · Playback (`▶`, ⌘2) · Refine (`✂`, ⌘3) ·
  Security Check (`◈`). The Subagents drill-in is reached only via the Overview Subagents card,
  never the rail.
- **`sb-bottom` — Ask (`∴`) then util.** `∴ Ask` is its OWN one-item group at the TOP of
  `sb-bottom`, fenced by a `sb-sep` ABOVE and BELOW (between it and Settings), signalling a
  cross-cutting capability (not nav, not chrome). It renders ONLY when `/api/ask/status` reports
  `enabled` (Settings `ask` toggle on AND the claude CLI present AND non-demo) — NOT hub-conditional,
  so it can show on a stock public install. Below it, the util group: Settings (`⚙`) · **Reference
  (`※`, NOT hub-conditional; it is chrome/meta, a thing you consult ABOUT the app)** · Feedback
  (`⊞`, link to GitHub issues) · Collapse toggle (`⟨`/`⟩`).

## Topbar (`src/App.tsx`, every route)

- Sync pill (`useSyncStatus`: "synced Xm ago" / "syncing…" / "sync failed"; click = sync now) —
  on EVERY page.
- LIVE pill — session-scoped ONLY (renders only when `atSession` and a live SSE stream is open).
- **Cost basis toggle** (`.cost-mode-toggle`, `CostModeToggle`, every route): two options,
  `List price` (theoretical, default) vs `Billed` (real). The control reads just `List price | Billed`
  (no `COST` `.cm-label` prefix). Global state (`src/costMode.tsx`, persisted); every cost figure
  across the app prices at the selected mode. `List price` = metered list price; `Billed` = what Chi
  pays, so subscription-covered models (Claude tiers, gpt-5.6 / Codex) read ~$0. The active mode is
  ALWAYS visibly labeled next to spend figures so no number silently changes meaning.
- Search (`⌕`, ⌘K) · "+ Import Sessions" · language dropdown (EN / 中文 / 日本語) — all every-route.
- NO "← Projects" back link anywhere (real URL routes; browser back/forward).
- **⌘J** routes to `/ask` from anywhere and focuses the input — ONLY when Ask is enabled (so the
  shortcut never lands on the soft-failed route). Not a topbar control (the topbar is full).

## Page width (`src/styles.css`)

**ONE width for every non-dashboard surface**, `--page-max` (1200px), defined once. The frame is
constant; readability is solved on the TEXT, not by moving the frame.

| | Surfaces |
|---|---|
| `--page-max` | `/safety`, `/reference` |
| full bleed (no cap) | `/`, `/projects`, `/project/:id`, `/session/:id` — dashboards, where density IS the point |

**Prose carries its own `ch` measure cap** so a wide frame never means a 200-character line
(`.bc-summary`, `.bc-anatomy` at 92ch).

**A surface must FILL its width.** Two rules:

- **When the natural measure is narrower than the frame, add COLUMNS, do not stretch lines.**
  `/reference` definitions read at ~70ch, so the list is a two-column GRID of bounded tiles
  (`repeat(auto-fill, minmax(400px, 1fr))`), collapsing to one column below ~840px. Each definition
  is a bounded tile (`--bg2` inset, bordered); cells stretch to a shared row height so rows align and
  one entry reads as distinct from the next. (A single-column FLOW does not align across the gutter.)

## Enumerables (exact sets — changing any is a contract edit)

- **Window toggle** (`/` hub `.rangebar`): `Today` · `7d` · `30d` · `90d` · `All`. Exactly five,
  in this order. Default = Today. Today = fractional-days-since-local-midnight; All = no cutoff.
- **Project rangebar** (`/project/:id` `.project-detail .rangebar`): `Today` · `7d` · `30d` ·
  `90d` · `All`. Same exact five, same order, same labels as the hub window toggle above — ONE
  shared vocabulary, sourced from ONE component (`src/RangeBar.tsx`) both surfaces mount, so the
  option sets/labels cannot drift independently. Default = All. Guard:
  `test/e2e/window-matrix.spec.ts` — "the rangebar on /project/:id has exactly the same Today /
  7d / 30d / 90d / All set as the / hub".
- **Hub tabs** (`/`): `Overview` · `Explore` · `Content` · `Spend` · `Sessions`. Exactly five;
  Overview default. Text tabs in the existing boxed `.tabs` chrome; the shared rangebar scopes every
  tab. Guard: `test/e2e/home.spec.ts` — "the hub at / shows exactly Overview / Explore / Content /
  Spend / Sessions tabs".
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
  `∑`=insights (the sidebar Insights item) `⊞`=feedback `◷`=brand `⎇`=git branch
  `⊘`=safety `※`=reference. `⌂`=Home is
  retired from chrome and does not appear anywhere in `src/`. Per-surface: `/` hub tabs are text;
  `/projects` rail rows use `⎇`/`⚙`; session rail uses the mode glyphs above.
  - **Known tracked gap:** `src/kinds.ts` `KIND_ICON` still maps `user`/`thinking`/`tool_use` to
    colored emoji (👤/💭/🔧) in Playback rows — adjudicated at the walk, per the rubric.
- **Nothing renders above the KPI strip on `/`** (#220). The briefing band, the status
  band and the Settings `homeBands` toggle that hid them are removed; the KPI strip is the FIRST
  element inside the Overview tab body. Guard: `test/e2e/home.spec.ts` — "nothing renders above the
  KPI strip".
- **Ops routes are hub-conditional.** The Safety ops surface (`/safety`) and its
  `sb-top` nav item render ONLY when
  `GET /api/hub/status` reports `present` (mode `live` or `demo`); when the hub is `absent` they
  are hidden and their routes fail soft (the page shows a "no hub connected" line, never a broken
  view). This is why a stock public install (no hub) still shows exactly Insights + Projects in
  `sb-top`. Guard: `test/e2e/ops-safety.spec.ts`. The demo walk pass screenshots the rendered
  surface.

## Per-surface content inventory (what each surface MUST show)

### `/` Overview tab — reading order is load-bearing (top → bottom)

Nothing renders above item 1: the Overview opens on the KPI strip (#220).

1. **KPI strip** (`.kpis`, `KpiStrip`) — headline tiles from one `/api/insights` fetch: Spend ·
   Sessions · Tokens · Agent active (InfoTip) · Your engaged (InfoTip, shows leverage) · Tool
   calls (InfoTip) · Error rate (InfoTip) · Commits. Exactly 8 tiles — no conditional 9th.
   - **Spend** carries a visible mode label (`list price` / `billed ~$0 under subscription`) and a
     sub-line `estimated from sessions`. ONE spend figure, estimated from the imported sessions and
     priced client-side from the shared price table. No second lane, no merge.
   - **Sessions** is the count of imported sessions in range, with a sub-label naming the number of
     projects touched.
2. **Activity block** (`.activity-card`, `ActivityBlock`) — **Today window ONLY** (absent on
   7d/30d/90d/All). Two groups: "Live now" + "Since you left". Each row: live-dot · session name ·
   project · error count (if > 0) · when (live / relative ended-at) · cost.
3. **Anomaly tile** (`.burn-card`, `AnomalyTile` — REPLACES BurnTile in place). Window spend vs a
   baseline (Today → 14-day daily median; 7d/30d/90d → prior period of the same length; All → NO
   baseline); headline (`.burn-now .v`) = ratio + flag with a `high` TEXT label when hot, warn tint
   when hot; support line (`.burn-now .s`) = the absolute comparison `$current vs $baseline ·
   <baselineLabel>`; comparison bar when a baseline exists; a clickable top-session row (persists on
   every window; All falls back to absolute spend). ADDS: a **top-movers line** (top 2 dimension
   movers, e.g. `◫ chronicle +$9.40 · ▤ claude-fable-5 +$7.10`); a **flagged-days line** on multi-day
   windows (`1 flagged day · Aug 24 →` linking to the Spend tab).
   No flagged-day markers live on the chart — the tile carries flags.
4. **Insights charts** (`InsightsCharts`) — **Spend over time** **FULL-WIDTH** (the headline chart,
   no half-width partner; title `SPEND OVER TIME`, no suffix) with a bare segmented **[project |
   provider]** stack toggle (no "stack:" word; `provider` = model vendor anthropic/openai/google, NOT
   `source`) + a quiet **median dash** on the same y-scale, labeled on the line (`median $6.70`), NO
   flagged-day markers · then `.grid2b` Working Rhythm | (Global tool mix (top 5 + Other) · Error rate
   by project) · Token usage by model table. **Spend by model AND Sources are RETIRED from Overview**
   (both moved to the Spend tab, paired there). **Top sessions by cost is RETIRED from Overview**
   (absorbed by the Sessions tab's cost sort). Spend-chart series are colored by **spend RANK** from
   the fixed `--c1..--c5` palette (distinct by construction), NOT the per-project identity hue (which
   would collide for two top-5-by-spend projects); the aggregated **Other** bar uses a visible neutral
   and shows only when it carries spend; the `<synthetic>` pseudo-model is excluded from every spend
   view. The recent-sessions ledger does NOT mount on `/` (see `/projects`).
7. **Provenance strip** (`.provenance-strip`, `ProvenanceStrip` in `src/home/ProvenanceStrip.tsx`) —
   **LAST**, the Overview tab ends here. One quiet line closing the page: session count per source
   tool, last sync, and the active cost basis. The topbar sync pill says WHEN data last landed; this
   says WHAT is behind the figures, which on a console merging four tools is the
   credibility question. Sources are derived from `insights.sessions`, the same derivation the Spend
   tab's Sources card uses.

The Explore / Content tabs render `ExploreTab` / `ContentTab` at `scope={all}` (same components
the project view uses per-project).

### `/` Spend tab — reading order top → bottom (`SpendTab.tsx`)

Chronicle's visual grammar wins; content is Varde-derived. Card titles use the `.card h3` recipe
(name + window only; explanations live in InfoTips, never caption suffixes). The shared rangebar
scopes the tab.

1. **Budget band** — FULL-WIDTH horizontal band (the anomaly is already the Overview tile, so the
   Spend tab carries budget alone up top). Eyebrow `Budget · <Month> · list price` + a `✎ edit`
   affordance (the budget is server-backed via `/settings` → `~/.chronicle/config.json`, so every
   surface reads the same number; an inline editor, NOT a `budget-config` gate). Body,
   left→right: big `$MTD` month-to-date number + (`of $Y · %` + `on track`/`approaching`/`over budget`
   state chip when a budget is set, else `month to date · no budget set`); a meter bar (fill +
   projection tick) that grows to fill the middle (only when a budget is set); stats `$/day pace ·
   peak day $N · $/active-day` (+ `on pace for ≈$Z` when no budget). **No Spend-tab Anomaly card**
   (anomaly lives in exactly one place, the Overview `AnomalyTile`).
2. **Chart row** (Overview `grid2` proportions): the upgraded spend-over-time chart (same
   project|provider toggle + median dash as Overview) | a **breakdown card** stacking **Spend by
   model** hbars ($, `<synthetic>` excluded) + **Sources** hbars (session count by tool vendor) —
   the two together match the chart's height.
3. **Plan windows** — ONE CARD PER ACCOUNT, `auto-fit` (a new account wraps in as one more card).
   Claude cards mirror the official usage page rows: `5h` (current session) · `7d` (all models) ·
   `fable` (top-tier model 7d — follow whatever the quota API reports, NEVER hardcode opus). Codex
   cards: `7d`. A `COVERED` tag once per card head, never per meter. Caption: quota-read posture +
   Settings opt-out (Claude) / local (Codex). Claude meters are opt-in-off outbound.
4. **Efficiency card** (Varde's ROW grammar, Chronicle-restyled): **DETECTORS** rows (name · value +
   lowercase state word · small bar · right-muted definition): cache hit rate · jumbo outputs ·
   long context · error rows. Below, two columns: **WASTE SIGNALS** (right-sizing approx `$/mo` ·
   cache churn `$` · repeat file reads — each with a brass "check" affordance) | **ROUTING
   COMPLIANCE** (on-roster % · off-roster models + `$` · Prepare promotion launcher).
5. **grid2**: **Priced skills** (Skill · Runs · Tokens · Cost) | **MCP server spend** hbars + the
   double-count caption.
- **Billed flip** everywhere (`Billed` cost basis): covered models re-rank ~$0 with a `COVERED` tag;
  no-model-split rows gray as `theoretical · no model split`.

### `/` Sessions tab — reading order top → bottom (`SessionsHubTab.tsx`)

1. **Header row**: a muted count line at left (`N sessions`, matching the KPI Sessions count). No
   toggle — there is one session set.
2. **Two-up aggregates** (`grid2b` grammar): **Busiest days** (Day · Sessions · Active · Tokens ·
   Cost) | **Busiest projects** (Project · Sessions · Msgs · Tokens · Cost). Both sortable, default
   **Cost desc**; ONLY the active column shows the down-caret (hover caret otherwise); headers
   `nowrap`.
3. **ONE sessions table** (replaces both the old Top-sessions and All-sessions): chips
   **[cost | duration | recent]**, **cost default** (the default option sits far left), FLAT in
   every mode (NO day sub-headers — day-grouping stays `/projects`-ledger-only; per-day tallies live
   in Busiest days). Columns: Session · Project (colored dot) · Source (pill) · Tools · Ctx · Active
   · Cost · When. **Click-to-extend** `N more sessions` (window-btn pattern, not infinite scroll);
   row click → `/session/:id`.
- The product ends with exactly **two** session lists: `/projects` ledger = manage; Sessions tab =
  analyze. The split is stated via an InfoTip, not a caption.

### `/projects` — chrome-sidebar: content column (center) + chrome rail (right)

Three vertical zones: the left app sidebar (`src/App.tsx`, untouched), a CENTER content column
(`.projects-content`), and a RIGHT chrome sidebar (`.right-rail`). No page `h1` (redundant next to
the sidebar nav, which already names the page). The ledger, not the project list, is the
primary/moving-list surface: it lives in the content column and stacks first at every width.

- **CENTER content column** (`.projects-content`, scrolls independently of the chrome rail at
  ≥1100px) — top to bottom: the filter toolbar (`.home-search`, scoped to the content column's own
  width, NOT spanning under the chrome rail), then the shared select command bar when either list is
  selecting (below), then `RecentLedger` (`.recent-ledger`): "Recent sessions" title + one small
  "☑ Select" affordance (only at rest — hidden while selecting), then (when any minor sessions exist,
  recent mode only) a visible `.minor-filter-notice` callout at the TOP of the ledger naming the count
  hidden by the noise gate + an InfoTip stating the exact gate definition; "Show them" expands the
  minor sessions INLINE in place (promote/ignore per row) — there is NO separate minor-sessions
  section at the bottom of the ledger. Then day-grouped rows (day-header tri-state checkbox in select
  mode), infinite lazy scroll. Noise gate: a session is "minor" only when short on BOTH axes
  (agent-active under threshold AND messages under threshold — AND, not OR), so substantive sessions
  are never hidden on one axis alone.
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
  rest). Below it, the dense project list — rows are `.rail-proj`, NEVER the bordered
  `.projects-grid` card treatment (`.projects-grid` must never exist) and NEVER a table (no
  `.colhead`/`<th>` — this is navigation). Row: colored `.pdot` · project name · optional live-dot
  (when a session in the project is live) … session count (`.c`) · gear menu (`⚙`). Meta line:
  branch (`⎇ <branch>`) or "needs association" · relative last-active time. No permanent
  border/background (base `border: 1px solid transparent`, visible on hover only) unless selected
  (checkbox + subtle tint, see multi-select below — no brass border on a selected row).
- **Gear rests visible**: `.rail-proj .gear` sits at a muted `opacity: .45` at rest, full opacity on
  row hover/focus or while a sync spins.
- **ONE shared full-width command bar for BOTH select flows** — entering select mode on EITHER list
  (the ledger's own "☑ Select", or the chrome rail's own "☑ Select") slides ONE `.command-bar` in
  directly under the filter toolbar, in the content column (`.projects-content > .command-bar`). The
  two flows are MUTUALLY EXCLUSIVE — entering one force-exits the other — so the bar only ever shows
  one at a time:
  - **Sessions**: `<N> sessions selected · Select all/Clear · Cancel · [chip: Select minor
    sessions (N), sessions-only] · ⌫ Remove (N)`, the `useSessionSelect` flow (two-step inline
    confirm, never `window.confirm`, 10s Undo toast, tombstone + re-sync); it portals into the
    command bar, not a boxed `.select-toolbar` inside the ledger.
  - **Projects**: `<N> projects selected · Select all/Clear · Cancel · ⟳ Sync (N) (immediate,
    spinner, sequential per project) · ⌫ Remove (N)` (two-step inline confirm, no undo — matches
    the single-project gear-menu remove, since `deleteProject` hard-deletes rather than tombstones).
  - `.select-toolbar` no longer appears anywhere on `/projects` (it still exists as a class, used
    only by the unrelated ProjectDetail Sessions-tab select flow).
- **Reflow** (`styles.css` `.projects-page`, `@media (min-width: 1100px)`): below 1100px the right
  sidebar LEAVES THE CHROME — it renders as a boxed "Projects" section (real border, `.right-rail`'s
  boxed-card styling) BELOW the ledger, in normal page flow (`.projects-page` itself is the single
  scroll container at this width) — ledger stays first. At ≥1100px, `.projects-page` hands its own
  padding/scroll off to its two children so the rail can reach true full height flush to the viewport
  edge — `.projects-content` (flex 1, own `overflow-y: auto`) left, `.right-rail`
  (`flex: 0 0 280px`, own `overflow-y: auto`) right.
- Ledger row click → session view; rail row click (outside select mode) → project analytics; rail
  gear menu → the enumerable above.

### `/project/:id` — Overview / Explore / Content / Sessions tabs (`ProjectDetail.tsx`).
### `/session/:id` — Overview / Playback / Refine / Security Check (`SessionView.tsx`); Subagents card on Overview.

The Overview **Subagents** card (`.subagent-row` rows) header is `Subagents · <N>` where N is the
whole-session run count (distinct `agent_id`, NOT distinct agent_type — the permanent data-scale
guard, see the pin inventory). Each row reads `<agent_type> · N run(s) · <tokens> tok` (an `InfoTip`
explains runs-vs-turns-vs-tokens). Drill-in is **two levels**, reached only from this card (never the
sidebar rail):
1. **Level 1 — click a type row** → a run-list table (`.rowlink` rows, columns Start / Duration /
   Turns / Tokens / Description) listing every run (`agent_id`) of that `agent_type`, sorted by
   start time.
2. **Level 2 — click a run row** → that run's transcript (`.subagent-conv`), filtered to
   `agent_id` (not the whole type — each run's messages render on their own, not interleaved with
   sibling runs of the same type).
Back affordances step back one level at a time (run transcript → run list → session Overview).

### Content tab — composition + three-card grid

- **Token composition rows sort DESC by token count** (`compositionRows`, zero-token rows sink to
  the bottom); each kind's bar color is stable (keyed to a fixed kind order), not positional, so it
  doesn't reshuffle as the sort order changes. `.grid2`/`.grid2b` card rows use `align-items:
  stretch` so shorter cards fill the row height instead of looking short next to a taller sibling.
- The **Tool results by tool | Skills | Subagents** cards are a `.grid3` row, each capped at 6 rows
  and each with its OWN bar-scale `max` (so a short list is not flattened under a shared max dominated
  by a heavier sibling). `.grid3` reflows via `auto-fit`/`minmax(200px,1fr)` (3 → 2+1 → 1-per-row),
  holding at 1024/1366/1728 without a dedicated media query.

### Content tab (`ContentTab.tsx`, shared by `/` all-scope, `/project/:id`, and session scope)

One card, titled **"What your usage says"**, carries the characteristics. The characteristics list is
**scope-tagged** (`ContentResult.characteristicsScope` + per-row
`Characteristic.format`/`value`/`value2`/`label`/`why`/`info`, all server-supplied so the client
never switches on a characteristic's `key`):
- **all/project scope: 7 rows** — `highContextRel` and `subagentTurns` lead, then
  `eightHourSessions` · `workflowRuns` · `highContextAbs` · `cacheEfficiency` · `autonomousShare`.
- **session scope: 6 rows.** The four threshold predicates that always collapse to a meaningless
  0%/100% at N=1 (`eightHourSessions`, `highContextAbs`, `highContextRel`, `autonomousShare`) are
  REPLACED with absolute session facts: `marathonBadge` (real active hours vs the 8h line),
  `peakContextTokens` (raw tokens + % of the model's window), and `unattendedRatio` (engaged ÷
  active, not a binary flag). `cacheEfficiency` / `subagentTurns` / `workflowRuns` carry over
  unchanged — real, non-binary percentages even for one session.

### `/safety` — ops surface (hub-conditional, `SafetyPage.tsx`)

Reading order: eyebrow `SAFETY` + lede → posture tiles → push posture → gate controls → write log →
accepted-gaps register.
- **Posture tiles** (4): Egress gate (ENABLED green / OFF fail-closed danger) · Spend caps
  (per-tx / per-session) · Tool classes (count + read/send/publish/spend breakdown) · Confidential
  markers (total COUNT + per-category counts, labeled "counts only" — the phrases never appear here).
- **Push posture** (read-only, no gate controls): one card per conditioned-auto push pin
  (repo, visibility, any-branch/confidentiality-scoped-off callout, feature-branch + PR-protected-branch
  posture, leak-scrub + scrub-whitelist COUNT) plus one dashed "Owner rule (unbounded)" card for the
  unpinned-repo default. Emit-ALLOWLIST per pin: `scrub_whitelist` values (identity regexes) are never
  rendered, only their count, same posture as confidential markers above. Hidden entirely when the
  gating-policy file is absent.
- **Gate controls** (only when a writable live hub is present; a single read-only note otherwise,
  incl. demo): edits over the connected hub's gate-config surfaces. **All of them card, always**:
  they edit the gate's own config, so every edit goes propose -> validated diff card
  (`GateConfirmDialog`) -> Confirm/Deny. The card names WHY it is carding. Surfaces that are off
  state the shared reason once, not per row.
- **Approval tiering**: the gate is not confirm-first over every write. Each surface declares
  `approval`, and ABSENT MEANS CONFIRM. Only surfaces writing Chronicle's own reversible state are
  `auto`; every hub-writing surface and the Tier 2 surface card. Floors live in
  `server/gate/core.ts`, not the registry: Tier 2 never autos, a hub-writing surface declaring auto
  throws at construction, a classifier that throws cards, and **model-generated content cards on
  every surface** (so a scope suggestion keeps its human review). The per-boot token still guards
  every write; only the human-confirm step is tiered.
- **Write log**: every gate write, newest first, off `GET /api/gate/audit`. Columns When · Surface ·
  Outcome (`applied` for a cardless write, else the raw event) · Change (reason + up to 3 diff rows,
  `+N more`) · Undo. **Undo** is offered on any row that took a backup; it is NOT its own approval
  category (the restore meets the same policy, so it cannot walk a loosening past a card) and it
  verifies the backup against a sha256 recorded at write time before restoring. Rows written
  through the hub, and action rows, have no local backup and say so.
- **Accepted-gaps register** (`data/safety-gaps.json`, synthetic-safe; operator override at
  `~/.chronicle/safety-gaps.json`): actionable + watch cards, each with exposure / blast radius /
  acceptance / (watch) revisit trigger. No launcher: the "Work on this" Terminal launch
  (`POST /api/launch/gap`) is removed (#220) — Chronicle no longer launches other programs. An
  actionable gap wears the `--attention` accent: "act on this" is one visual language app-wide,
  and never the everyday brass. Watch cards stay neutral.
- **Confidentiality floor**: emit-ALLOWLIST per file (not a denylist) + a value-side creds scan;
  marker phrases are COUNTS only. The raw-phrase drill-down (`GET /api/hub/safety/confidential`) is
  HARD-GATED: a live hub AND an explicit opt-in flag, else 403. The default/public build never
  serves confidential content.
- **Demo**: posture shows synthetic data; the gate is INERT for writes (all surfaces unavailable,
  propose/apply 409), so a demo never touches real machine state (hub config files, scheduled jobs).

### Settings modal (`SettingsModal`, `src/App.tsx`)

Toggle rows, in order: **Auto-sync sessions** · **Pause auto-sync** · **Claude plan windows
(quota)** · **Ask (experimental)**.
Then one BLOCK, fenced by a rule: the **Local view log** — an on/off toggle, a one-paragraph
statement of exactly what is recorded and that it never leaves the machine, the captured-rows count
and date range, a top-5 surfaces table (Surface / You / Agent / Typical visit, human vs agent
collapsed at read time), and a **Clear the log** action. The block renders "Nothing recorded yet"
when empty and is absent in demo (demo never records).

## Pin inventory (each enumerable → its guarding e2e test — the contract self-audits)

| Enumerable / shape fact | Guarding test |
|---|---|
| Sidebar = exactly Insights + Projects, no Home entry, no `⌂` (hub ABSENT — the default e2e harness) | `test/e2e/home.spec.ts` — "sidebar top nav has exactly Insights and Projects, no Home entry" |
| Safety nav hidden + `/api/hub/safety` absent-sentinel when the hub is absent | `test/e2e/ops-safety.spec.ts` — "no Safety nav item; /api/hub/safety returns the absent sentinel" |
| `/safety` posture tiles + accepted-gaps render (demo); gate controls inert in demo | `test/e2e/ops-safety.spec.ts` — "posture tiles + accepted-gaps render; gate controls are read-only in demo" |
| The briefing, the launcher and the scope-suggest routes are unmounted (404); `/settings` has no `homeBands` | `test/removed-routes.test.mjs` |
| Nothing renders above the KPI strip on `/` | `test/e2e/home.spec.ts` — "nothing renders above the KPI strip" |
| Actionable gap cards carry the off-brass `--attention` accent; watch cards stay neutral | `test/e2e/ops-safety.spec.ts` — "actionable gap cards use the off-brass attention accent" |
| Confidential marker drill-down is 403 by default (never served on the public build) | `test/e2e/ops-safety.spec.ts` + `test/hub-safety.test.mjs` — confidentialMarkersEnabled gating |
| Safety slice emit-allowlist (no innocuous-key creds leak), markers as COUNTS only | `test/hub-safety.test.mjs` (node) — allowlist + planted-secret + counts assertions |
| Gap launcher refuses demo (409); prompt built server-side | `test/e2e/ops-safety.spec.ts` + `test/hub-safety.test.mjs` |
| `∴ Ask` entry hidden + `/api/ask/status` `enabled:false` + `/ask` fails soft when Ask is off (default) | `test/e2e/ask.spec.ts` — "no ∴ Ask sidebar entry…" + "navigating to /ask fails soft" |
| Ask gating formula `enabled === toggleOn && claudePresent && !demo` never drifts | `test/e2e/ask.spec.ts` — the formula assertion in both describes |
| `POST /api/ask` refused with 409 in demo; `∴ Ask` never shows in demo | `test/e2e/ask.spec.ts` — "POST /api/ask returns 409 (nothing spawns)" |
| Ask runner SELECT-only guard (accept SELECT/WITH, reject writes/DDL/PRAGMA/ATTACH/multi-statement/comment-smuggle) + deduped cost views reconcile | `test/ask.test.mjs` (17 unit tests) |
| Hub tabs = Overview / Explore / Content / Spend / Sessions (exactly five), Overview default | `test/e2e/home.spec.ts` — "the hub at / shows exactly Overview / Explore / Content / Spend / Sessions tabs" |
| Window toggle = Today / 7d / 30d / 90d / All (exactly five) | `test/e2e/home.spec.ts` — "the window toggle on / has exactly…" |
| `/insights` (and `?tab=`) redirects to `/` | `test/e2e/home.spec.ts` — "/insights redirects…" + "…?tab=explore…" |
| Overview DOM order KPIs → activity → anomaly tile → charts, no ledger, no top-sessions-by-cost | `test/e2e/home.spec.ts` — "Overview reading order KPIs → activity → anomaly → charts" |
| Activity block Today-only; anomaly tile persists on 7d | `test/e2e/home.spec.ts` — "window toggle to 7d hides the Activity block, anomaly tile persists" |
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
| Content composition rows sort DESC by tokens; Tool results/Skills/Subagents split into three independently-scoped cards | `test/e2e/window-matrix.spec.ts` (comment-level; no dedicated shape assertion beyond `assertContentNonEmpty` — visual conformance judged at the design-QA walk) |
| Anomaly tile headline = ratio + flag (`high` text label), support = absolute `$current vs $baseline`, + movers/flagged-days lines (keeps the burn-tile anatomy) | no dedicated e2e pin (no probe touches `.burn-now` internals); visual conformance judged at the design-QA walk vs the pixel reference |
| Spend tab renders budget band → chart row (spend-over-time + spend-by-model/Sources) → plan windows → efficiency → skills/mcp; NO anomaly card (Overview-tile-only), NO Spend-by-model on Overview | `test/e2e/spend-tab.spec.ts` — "Spend tab reading order + budget band present" |
| Spend-over-time stack toggle = exactly [project \| provider]; toggling repaints series without cross-mode color bleed; median dash on the same y-scale, no flagged-day chart markers | `test/e2e/spend-tab.spec.ts` — "spend chart stack toggle is project/provider, one y-axis, no flagged markers" |
| Monthly budget is server-backed: the Spend tab round-trips it through `/settings` → `~/.chronicle/config.json` (migrating a legacy localStorage value once) | `test/settings-budget.test.mjs` — `/settings` normalizes monthlyBudget |
| Sessions tab = count line + 2-up aggregates + ONE flat sessions table (chips cost\|duration\|recent, cost default), click-to-extend | `test/e2e/sessions-tab.spec.ts` — "Sessions tab two-up aggregates + one flat table" |
| Exactly two session lists product-wide: /projects ledger + Sessions tab (no third) | `test/e2e/sessions-tab.spec.ts` — "no day sub-headers in the Sessions-tab table (grouping is ledger-only)" |
| Explore dimensions include `mcp` (per-server, calibrated) + `provider` (model vendor) | `test/explore-mcp-provider.test.mjs` (node) — mcp derivation + provider mapping + calibrated flag |
| Explore session grouping / Other segment | `test/e2e/explore.spec.ts` |
| Content characteristics: 7 shares at all/project scope, 6 session facts at session scope, merged into one "What your usage says" card | `test/e2e/content-characteristics.spec.ts` |
| Playback selection drives panels | `test/e2e/playback.spec.ts` |
| InfoTip opens downward, closes, no viewport clip | `test/e2e/infotip.spec.ts` |
