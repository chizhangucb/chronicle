# Chronicle surface contract

> Grandfathered sub-contract of `spec/product-contract.md` (the module contract). This file is
> the frozen product shape / IA: routes, surfaces, sidebar/topbar chrome, the enumerable sets, the
> per-surface content inventory, and the e2e pin table. Register-not-rewrite (CHI-303) — the shape
> below is settled and only changes by the rule immediately following. It is the IA-conformance
> target the release walk reads (`npm run walk`, judged alongside `spec/design-qa-rubric.md`).

> **Change rule.** This file changes ONLY with Chi's explicit sign-off. A PR that touches
> product shape (a route, a surface's block/card inventory, the sidebar set, an enumerable
> below) WITHOUT a matching edit to this file plus a sign-off note in the PR description is
> **drift by definition** — the release-walk conformance lens fails it and publish is blocked
> (IA drift = P0). "Sign-off note" = one line naming Chi's confirmation (brainstorm/message/
> live call) for the shape change.

> **CHI-323 phase-1 sign-off (consolidated).** The five hub-conditional ops surfaces (Modules
> `/modules`, Safety `/safety`, Jobs `/jobs`, Briefing `/briefing`, Memory `/memory`), the
> hub-conditional ops-nav enumerable, the write gate, and the per-surface inventories below were
> added across sub-steps 1a-1h of the CHI-322 Chronicle/Varde merge (decision CHI-307, plan
> `plans/2026-08-25-chi-323-chronicle-merge-phase1-port.md`, LOCKED). Landed under Chi's standing
> phase-1 sign-off delegation (per-organ screenshots reviewed in-session; the V2 Nebula pixels
> reviewed live before 1g merge, D4). Ops glyphs are D6 (delegated). Two disclosed phase-1 gaps were
> named in their per-surface inventories as fast-follows: memory scope-suggest shipped under
> CHI-339 (self-signed, same delegation — see the `/memory` inventory); the briefing spend cards
> shipped under CHI-324 2i (phase-2 spend detector, server-side — the D7 gap closed). This paragraph
> is that sign-off.

> **CHI-324 phase-2 sign-off (consolidated).** The spend/sessions consolidation reshapes the hub
> tabs 3 → 5 (Overview / Explore / Content / **Spend** / **Sessions**), replaces the Overview
> BurnTile with an anomaly tile, retires Overview's Top-sessions-by-cost, upgrades the spend chart
> (project|provider stack toggle + a median dash, no flagged-day markers), and adds a 6th
> hub-conditional ops surface **Records** (`/records`). Every surface was rendered as a mockup and
> approved by Chi one-by-one in the CHI-324 D3 Fable design session (2026-08-26; pixel reference
> artifact `06128eb0-1e78-46f4-915e-d0e3875f68c3`, each approved surface badged "Approved"), relayed
> via session chronicle-2e. Plan: `plans/2026-08-26-chi-324-phase2-spend-sessions-consolidation.md`
> (Chi-approved 2026-08-26; D1/D3/D7 signed). This paragraph is that sign-off; the release walk
> judges the built pixels against the artifact. (The `/ask` surface floated in that session is
> OUT of CHI-324 — it gets its own ticket + plan review, and is NOT added here.)

The agreed product shape as enumerable, checkable facts — reflecting the CURRENT
(post-F1/F2, post-2026-08-14-feedback-round-D1/D2/D14, post-CHI-323-phase-1) branch state, which is Chi's latest
confirmed calls. Where this disagrees with
the spec (`~/chizhang-2/records/plans/2026-08-12-chronicle-quality-pass-design.md`), the branch
state wins (F1/F2 fixed the surfaces to Chi's confirmed shape after the plan compressed it).
This is JUDGE input, a sibling of `spec/design-qa-rubric.md`: the rubric judges *aesthetics/
layout*, this judges *product shape / IA*. Every statement is verifiable against `src/` on this
branch. Each enumerable names the e2e pin that guards it, so the contract is self-auditing.

## Routes & surfaces

| Route | Surface | Component |
|---|---|---|
| `/` | The ONE Insights hub, sidebar item **`∑ Insights`** — tabs Overview / Explore / Content / Spend / Sessions (CHI-324) | `src/HomeDashboard.tsx` |
| `/projects` | Chrome-sidebar layout, no h1: a CENTER content column (filter toolbar, shared select command bar, "Recent sessions" ledger — stacks first below 1100px) + a RIGHT chrome sidebar (same tone as the left app sidebar, full height, flush to the window edge >=1100px; eyebrow `PROJECTS · N`, borderless nav rows, gear visible at rest) | `src/ProjectsPage.tsx` |
| `/project/:id` (`/explore`, `/content`) | Project analytics — Overview / Explore / Content / Sessions | `src/ProjectDetail.tsx` |
| `/session/:id` | Session view — Overview / Playback / Refine + Security Check | `src/SessionView.tsx` |
| `/insights` | **Redirect only** → `/` (preserves a `?tab=` deep-link: `/insights?tab=explore` → `/?tab=explore`) | `src/App.tsx` |
| `/modules` | **Ops surface (hub-conditional, CHI-323 3a).** The hub `## Modules` registry + a read-only snapshot of each module's `product-contract.md`: a table (Module / Tier / Purpose / Project / Contract-status badge) + a detail panel showing the selected contract's markdown. Rendered ONLY when `/api/hub/status` reports present (live or demo); hidden + unreachable when absent. | `src/ModulesPage.tsx` |
| `/safety` | **Ops surface (hub-conditional, CHI-323 3d).** A descriptive read of the egress gate posture (config emit-allowlisted, marker phrases reduced to COUNTS) + the accepted-gaps register + confirm-first controls that edit the hub-write gate surfaces (kill switch, spend caps, classification, markers, hermes-approvals). Same hub-conditional gating as `/modules`. | `src/SafetyPage.tsx` |
| `/jobs` | **Ops surface (hub-conditional, CHI-323 3c).** Every scheduled thing on the machine in one list (launchd + cron + hub registry + repo templates) with live state, a log-tail drill-in, and confirm-first pause/resume via the gate's `launchd-jobs` surface. Chronicle's own templates ship DORMANT (install via `scripts/install-jobs.mjs`); demo shows synthetic jobs and the gate is inert. | `src/JobsPage.tsx` |
| `/briefing` | **Ops surface (hub-conditional, CHI-323 3d).** The daily briefing's action cards (needs-you / awareness / handled) with terminal-outcome actions (done/dismiss/snooze/reopen) and a Run-now. The grandfathered two-file split (run writes `briefing.json`, the UI writes `briefing-state.json`, never cross-writing). Covers jobs / safety / coverage AND spend (spend-anomaly cards, CHI-324 2i — the D7 gap closed). | `src/BriefingPage.tsx` |
| `/memory` | **Ops surface (hub-conditional, CHI-323 3e).** The V2 Nebula: a 3D force-graph (`react-force-graph-3d` + `three`, lazy-loaded) over the hub's markdown knowledge graph (titles/paths only, confidential pruned server-side), colored by deterministic community, with a node inspector, open-note, a communities legend, and a scope readout. Same hub-conditional gating. | `src/MemoryPage.tsx` |
| `/records` | **Ops surface (hub-conditional, CHI-324).** The append-only hub records, via the new `records()` adapter slice. A record-TYPE switcher (boxed tabs) whose ONLY phase-2 type is **Sessions** (`records/sessions.jsonl`): a table Date · Session ID · Repo · Focus, newest first, text filter + repo chips, click-to-extend, NO rangebar; imported session ids link to `/session/:id`, else plain mono. Future types (decisions, wiki sources, CHI-314) are switcher stubs only. Same hub-conditional gating as the other ops surfaces. | `src/RecordsPage.tsx` |
| `/ask` | **Ask (CHI-351): NOT hub-conditional — gated on the Settings `ask` toggle AND the claude CLI being present AND a non-demo console, all decided server-side by `/api/ask/status` (`enabled = toggleOn && claudePresent && !demo`).** One conversation column: eyebrow `ASK`, day dividers, right-aligned questions, answer cards (prose + full-width result table + `SQL ▸` expander + cost-basis label + a `re-ask under {other basis}` action), a bottom input bar, and a "nothing leaves your machine" footer. Durable local history at `~/.chronicle/ask-history.jsonl` (newest 500). Each answer is produced by an operator-initiated local `claude -p` spawn confined to EXACTLY ONE tool — a read-only, SELECT-only query server over `chronicle.db` (`--tools "" --allowedTools mcp__chronicledb__query --strict-mcp-config`; the read-only handle is the hard guarantee). Dollar figures use the two deduped cost surfaces (`session_model_cost` reconciles with the Insights dashboards) so `/ask` never contradicts the dashboards. Renders the page ONLY when enabled; otherwise the route fails soft (a "not available" message). Demo refuses `POST /api/ask` with 409 like every runner. | `src/AskPage.tsx` |

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
- **`sb-top` nav — two ALWAYS-ON items:** Insights (`∑`) and Projects (`◫`). NO Home entry, no
  `⌂` glyph in the sidebar — the hub at `/` is labeled **Insights** everywhere (sidebar item
  title, `/` page title), never "Home" (per Chi, 2026-08-14 feedback round, D2 —
  `records/plans/2026-08-14-chronicle-feedback-round-plan.md`; pixels checkpoint before merge
  on PR). Projects highlights across every project-scoped route (`/projects`,
  `/project/:id[/explore|/content]`, `/session/:id`) but NOT on the Insights hub.
- **`sb-top` ops nav — hub-conditional (CHI-323).** After Projects, the ops items render ONLY
  when `/api/hub/status` reports present (live or demo); ALL hidden when the hub is absent. As
  organs land they are added here in order: **Modules (`▦`)** [1c] · **Safety (`⊘`)** [1d] ·
  **Jobs (`⧗`)** [1e] · **Briefing (`▣`)** [1f] · **Memory (`❖`)** [1g] · **Records (`≡`)** [CHI-324]
  — six ops organs now present (Records is the CHI-324 addition, after Memory). So on a stock public
  install with
  no hub, `sb-top` is exactly Insights + Projects (the existing pin holds); with a hub or in demo
  it also carries the ops items. See the "ops routes are hub-conditional" enumerable below.
- **Session modes** — appear in `sb-top` ONLY while a session is open, published up from
  `SessionView` via `onRailChange`: Overview (`⬚`, ⌘1) · Playback (`▶`, ⌘2) · Refine (`✂`, ⌘3) ·
  Security Check (`◈`). The Subagents drill-in is reached only via the Overview Subagents card,
  never the rail.
- **`sb-bottom` — Ask (`∴`, CHI-351) then util.** `∴ Ask` is its OWN one-item group at the TOP of
  `sb-bottom`, fenced by a `sb-sep` ABOVE and BELOW (between it and Settings), signalling a
  cross-cutting capability (not nav, not chrome). It renders ONLY when `/api/ask/status` reports
  `enabled` (Settings `ask` toggle on AND the claude CLI present AND non-demo) — NOT hub-conditional,
  so it can show on a stock public install. Below it, the util group: Settings (`⚙`) · Feedback
  (`⊞`, link to GitHub issues) · Collapse toggle (`⟨`/`⟩`).

## Topbar (`src/App.tsx`, every route)

- Sync pill (`useSyncStatus`: "synced Xm ago" / "syncing…" / "sync failed"; click = sync now) —
  on EVERY page.
- LIVE pill — session-scoped ONLY (renders only when `atSession` and a live SSE stream is open).
- **Cost basis toggle** (`.cost-mode-toggle`, `CostModeToggle`, every route): two options,
  `List price` (theoretical, default) vs `Billed` (real). The control reads just `List price | Billed`
  — the `COST` `.cm-label` prefix is REMOVED (CHI-324, cross-cutting). Global state (`src/costMode.tsx`,
  persisted); every cost figure across the app prices at the selected mode. `List price` = metered
  list price; `Billed` = what Chi pays, so subscription-covered models (Claude tiers, gpt-5.6 /
  Codex) read ~$0. The active mode is ALWAYS visibly labeled next to spend figures so no number
  silently changes meaning.
- Search (`⌕`, ⌘K) · "+ Import Sessions" · language dropdown (EN / 中文 / 日本語) — all every-route.
- NO "← Projects" back link anywhere (real URL routes; browser back/forward).
- **⌘J (CHI-351)** routes to `/ask` from anywhere and focuses the input — ONLY when Ask is enabled
  (so the shortcut never lands on the soft-failed route). Not a topbar control (the topbar is full).

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
- **Hub tabs** (`/`): `Overview` · `Explore` · `Content` · `Spend` · `Sessions`. Exactly five
  (CHI-324, was three); Overview default. Text tabs in the existing boxed `.tabs` chrome; the shared
  rangebar scopes every tab. Guard: `test/e2e/home.spec.ts` — "the hub at / shows exactly Overview /
  Explore / Content / Spend / Sessions tabs".
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
  `▦`=modules (ops nav, CHI-323; `⊘`=safety `⧗`=jobs `▣`=briefing
  `❖`=memory `≡`=records [CHI-324]). `⌂`=Home is
  retired from chrome — the sidebar item it used to label was renamed to `∑ Insights` (D2, see
  above); `⌂` does not appear anywhere in `src/`. Per-surface: `/` hub tabs are text;
  `/projects` rail rows use `⎇`/`⚙`; session rail uses the mode glyphs above.
  - **Known tracked gap (NOT a novel finding):** `src/kinds.ts` `KIND_ICON` still maps
    `user`/`thinking`/`tool_use` to colored emoji (👤/💭/🔧) in Playback rows — adjudicated at
    the walk, per the rubric.
- **Ops routes are hub-conditional (CHI-323, +Records CHI-324).** The ops surfaces (Modules
  `/modules`, Safety / Jobs / Briefing / Memory, and Records `/records`) and their `sb-top` nav items render ONLY when
  `GET /api/hub/status` reports `present` (mode `live` or `demo`); when the hub is `absent` they
  are hidden and their routes fail soft (the page shows a "no hub connected" line, never a broken
  view). This is why a stock public install (no hub) still shows exactly Insights + Projects in
  `sb-top`. Guard: `test/e2e/ops-modules.spec.ts` — "the Modules nav item is not rendered and the
  API returns the absent sentinel" (absent) + "ops nav shows Modules and the page lists the
  synthetic modules" (demo). The demo walk pass (1h) screenshots the rendered surfaces.

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
3. **Anomaly tile** (`.burn-card`, `AnomalyTile` — REPLACES BurnTile in place, CHI-324 2c). Keeps
   BurnTile's D6 anatomy and window rules unchanged: window spend vs a baseline (Today → 14-day
   daily median; 7d/30d/90d → prior period of the same length; All → NO baseline); headline
   (`.burn-now .v`) = ratio + flag with a `high` TEXT label when hot, warn tint when hot; support
   line (`.burn-now .s`) = the absolute comparison `$current vs $baseline · <baselineLabel>`;
   comparison bar when a baseline exists; a clickable top-session row (persists on every window; All
   falls back to absolute spend). ADDS (CHI-324): a **top-movers line** (top 2 dimension movers,
   e.g. `◫ chronicle +$9.40 · ▤ claude-fable-5 +$7.10`); a **flagged-days line** on multi-day
   windows (`1 flagged day · Aug 24 →` linking to the Spend tab); and the **Lane-C note** when
   proxy spend contributes to the total (`incl. $0.42 proxy lane, not attributable to a mover`, D8).
   No flagged-day markers live on the chart — the tile carries flags.
4. **Insights charts** (`InsightsCharts`) — **Spend over time** **FULL-WIDTH** (CHI-324 review: the
   headline chart, no half-width partner; title stays `SPEND OVER TIME`, no suffix) with a bare
   segmented **[project | provider]** stack toggle (no "stack:" word; `provider` = model vendor
   anthropic/openai/google per D6, NOT `source`) + a quiet **median dash** on the same y-scale,
   labeled on the line (`median $6.70`), NO flagged-day markers (CHI-324 2d) · then `.grid2b`
   Working Rhythm | (Global tool mix (top 5 + Other) · Error rate by project) · Token usage by model
   table. **Spend by model AND Sources are RETIRED from Overview** (CHI-324 review — both moved to
   the Spend tab, paired there; pairing the tall spend chart with a 2-row Sources card left an empty
   half). **Top sessions by cost is RETIRED from Overview** (CHI-324 — absorbed by the Sessions tab's
   cost sort). Spend-chart series are colored by **spend RANK** from the fixed `--c1..--c5` palette
   (distinct by construction), NOT the per-project identity hue (assigned by project id, which would
   collide for two top-5-by-spend projects); the aggregated **Other** bar uses a visible neutral and
   shows only when it carries spend; the `<synthetic>` pseudo-model is excluded from every spend
   view. **LAST** — the Overview tab ends here. The recent-sessions ledger does NOT mount on `/`
   (Task 9, D1 — see `/projects`).

The Explore / Content tabs render `ExploreTab` / `ContentTab` at `scope={all}` (same components
the project view uses per-project).

### `/` Spend tab — reading order top → bottom (CHI-324 2b/2d/2e/2f, `SpendTab.tsx`)

Chronicle's visual grammar wins; Varde contributes content only. Card titles use the `.card h3`
recipe (name + window only; explanations live in InfoTips, never caption suffixes). The shared
rangebar scopes the tab.

1. **Budget band** — FULL-WIDTH horizontal band (CHI-324 review: the anomaly is already the Overview
   tile, so the Spend tab carries budget alone up top; a full-width horizontal layout fills the row
   with no empty half). Eyebrow `Budget · <Month> · list price` + a `✎ edit` affordance (localStorage
   budget; the gated `budget-config` editor is D5). Body, left→right: big `$MTD` month-to-date number
   + (`of $Y · %` + `on track`/`approaching`/`over budget` state chip when a budget is set, else
   `month to date · no budget set`); a meter bar (fill + projection tick) that grows to fill the
   middle (only when a budget is set); stats `$/day pace · peak day $N · $/active-day` (+ `on pace
   for ≈$Z` when no budget). **The Spend-tab Anomaly card is RETIRED** (CHI-324 review — it duplicated
   the Overview tile; anomaly lives in exactly one place, the Overview `AnomalyTile`).
2. **Chart row** (Overview `grid2` proportions): the upgraded spend-over-time chart (same
   project|provider toggle + median dash as Overview) | a **breakdown card** stacking **Spend by
   model** hbars ($, `<synthetic>` excluded) + **Sources** hbars (session count by tool vendor,
   moved here from Overview) — the two together match the chart's height.
3. **Plan windows** — ONE CARD PER ACCOUNT, `auto-fit` (a new account wraps in as one more card).
   Claude cards mirror the official usage page rows: `5h` (current session) · `7d` (all models) ·
   `fable` (top-tier model 7d — follow whatever the quota API reports, NEVER hardcode opus). Codex
   cards: `7d`. A `COVERED` tag once per card head, never per meter. Caption: quota-read posture +
   Settings opt-out (Claude) / local (Codex). Claude meters are opt-in-off outbound (D7).
4. **Efficiency card** (Varde's ROW grammar, Chronicle-restyled): **DETECTORS** rows (name · value +
   lowercase state word · small bar · right-muted definition): cache hit rate · jumbo outputs ·
   long context · error rows. Below, two columns: **WASTE SIGNALS** (right-sizing approx `$/mo` ·
   cache churn `$` · repeat file reads — each with a brass "check" affordance) | **ROUTING
   COMPLIANCE** (on-roster % · off-roster models + `$` · Prepare promotion launcher).
5. **grid2**: **Priced skills** (Skill · Runs · Tokens · Cost) | **MCP server spend** hbars + the
   double-count caption (D6).
6. **Proxy lane** slim row (`authoritative $ · not session-linked`, D8).
- **Billed flip** everywhere (`Billed` cost basis): covered models re-rank ~$0 with a `COVERED` tag;
  no-model-split rows gray as `theoretical · no model split`; the proxy lane stays real. D9
  placements exactly as rendered in the D3 artifact.

### `/` Sessions tab — reading order top → bottom (CHI-324 2g, `SessionsHubTab.tsx`)

1. **Header row**: a muted count line at left; a right-aligned **[human | all]** toggle + InfoTip
   (human default = interactive only, matching the KPI Sessions count; `all` adds headless
   automation).
2. **Three-up aggregates** (`grid3` grammar, `auto-fit` 3 → 2+1 → 1): **Busiest days** (Day ·
   Sessions · Active · Tokens · Cost) | **Busiest projects** (Project · Sessions · Msgs · Tokens ·
   Cost) | **Automation by job** (Job · Runs · Tokens · Cost; InfoTip: always automation, unaffected
   by the toggle — sourced from `~/.aios/machine_sessions.jsonl` via `machineSessions.ts`, NOT
   `automations.ts`). All three sortable, default **Cost desc**; ONLY the active column shows the
   down-caret (hover caret otherwise); headers `nowrap`.
3. **ONE sessions table** (replaces both the old Top-sessions and All-sessions): chips
   **[cost | duration | recent]**, **cost default** (the default option sits far left), FLAT in
   every mode (NO day sub-headers — day-grouping stays `/projects`-ledger-only; per-day tallies live
   in Busiest days). Columns: Session · Project (colored dot) · Source (pill) · Tools · Ctx · Active
   · Cost · When. **Click-to-extend** `N more sessions` (window-btn pattern, not infinite scroll);
   row click → `/session/:id`.
- The product ends with exactly **two** session lists: `/projects` ledger = manage; Sessions tab =
  analyze. The split is stated via an InfoTip, not a caption.

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

### `/modules` — ops surface (hub-conditional, `ModulesPage.tsx`, CHI-323 3a)

Reading order: eyebrow `MODULES · N` + one-line lede → a registry table → a contract detail panel.
- **Registry table** columns, in order: Module (name, bold) · Tier · Purpose · Project · Contract
  (status badge). One row per module in the hub's `## Modules` table (operations.md), parsed by
  header name. Rows with no Module cell are dropped.
- **Contract status badge** = `full` / `grandfathered` (both green, contract readable) · `pending`
  (warn, cell was `(pending CHI-NNN)`) · `n/a` (muted, unreadable/out-of-policy). A contract is
  read ONLY from a path named `product-contract.md` that does not pass through
  `confidential/`/`next-ventures/` — any other path degrades to `n/a`, never read.
- **Contract detail** (right, appears on row select): the module name + status badge, then the
  snapshotted `product-contract.md` markdown in a mono block (read-only, scrolls). Pending/
  unreadable contracts show a one-line reason instead.
- **Absent/empty states**: reached with no hub → "no hub connected" line; hub present but no
  `## Modules` table → "no module registry found" line. Never a blank or broken page.

**CHI-323 sign-off (phase-1 merge, organ 1c):** first ops organ of the CHI-322 Chronicle/Varde
merge (decision CHI-307, plan `plans/2026-08-25-chi-323-chronicle-merge-phase1-port.md`). Ops
glyphs are D6 (delegated). This edit is landed under Chi's standing sign-off delegation for the
phase-1 organs; the consolidated phase-1 note (all five organs, CHI-307/322/323 + plan) lands
with 1h.

### `/safety` — ops surface (hub-conditional, `SafetyPage.tsx`, CHI-323 3d)

Reading order: eyebrow `SAFETY` + lede → posture tiles → gate controls → accepted-gaps register.
- **Posture tiles** (4): Egress gate (ENABLED green / OFF fail-closed danger) · Spend caps
  (per-tx / per-session) · Tool classes (count + read/send/publish/spend breakdown) · Confidential
  markers (total COUNT + per-category counts, labeled "counts only" — the phrases never appear here).
- **Gate controls** (confirm-first, only when a writable live hub is present; a single read-only
  note otherwise, incl. demo): kill switch toggle (destructive confirm) · spend-cap inputs · JSON
  editors for classification / confidential-markers / hermes-approvals (Tier 2). Every edit goes
  propose -> validated diff card (`GateConfirmDialog`) -> Confirm/Deny; nothing writes without the card.
- **Accepted-gaps register** (`data/safety-gaps.json`, synthetic-safe; operator override at
  `~/.chronicle/safety-gaps.json`): actionable + watch cards, each with exposure / blast radius /
  acceptance / (watch) revisit trigger + a "Work on this" launcher (`POST /api/launch/gap`: Terminal
  print -z on macOS, clipboard fallback elsewhere, demo-refused).
- **Confidentiality floor**: emit-ALLOWLIST per file (not a denylist) + a value-side creds scan;
  marker phrases are COUNTS only. The raw-phrase drill-down (`GET /api/hub/safety/confidential`) is
  HARD-GATED (D8): a live hub AND an explicit opt-in flag, else 403. The default/public build never
  serves confidential content.
- **Demo**: posture shows synthetic data; the gate is INERT for writes (all surfaces unavailable,
  propose/apply 409), so a demo never touches real machine state (~/.hermes, launchd).

**CHI-323 sign-off (organ 1d):** landed under the same phase-1 delegation as 1c.

### `/jobs` — ops surface (hub-conditional, `JobsPage.tsx`, CHI-323 3c)

Reading order: eyebrow `JOBS · N` + per-source counts → jobs table.
- **Table** columns: Job (name + description + agent/model) · Source (launchd / cron / registry /
  repo-template) · Schedule · Status badge · Last run · actions.
- **Status badge**: success/running (green) · failed (danger) · stale/paused (warn) ·
  pending/disabled/not-installed (muted). Registry heartbeat health (stale/failed) outranks a
  launchd exit of 0.
- **Actions**: a Log button (only when the job declares a log path) opens a modal tailing the last
  ~100 lines of exactly the paths the slice declared (the browser never sends a path). launchd jobs
  get a confirm-first Pause / Resume through the gate's `launchd-jobs` surface. A `not-installed`
  repo-template shows the CLI install hint (`node scripts/install-jobs.mjs`) — Chronicle's own job
  templates ship DORMANT (never auto-installed, so no duplicate daily run).
- **Demo**: synthetic jobs (no real machine scan); the gate is inert so Pause/Resume 409s.

**CHI-323 sign-off (organ 1e):** same phase-1 delegation.

### `/briefing` — ops surface (hub-conditional, `BriefingPage.tsx`, CHI-323 3d)

Reading order: header (`as of` + open/snoozed counts + Run-now) → card sections.
- **Two-file contract (grandfathered)**: the run writes `~/.chronicle/briefing.json`; the UI writes
  `~/.chronicle/briefing-state.json`. They never cross-write, so a run can never clobber a "done".
- **Card sections**: Needs you (open + needsYou, brass accent) · For your awareness (open FYI) ·
  Handled (done/dismissed/resolved/snoozed). Each card: domain chip · title · summary · optional
  plain-language anatomy (what happened / means / to do) · evidence expander · an internal link ·
  terminal actions (Done / Snooze / Dismiss, or Reopen). A card is binary (needs you or not) — no
  severity ladder.
- **Spend cards (CHI-324 2i)**: the runner assembles a `spend` slice (`server/spendSnapshot.ts`) —
  the SAME costed days + shared thresholds the Spend tab runs on, priced server-side at the fixed
  theoretical (list) basis. The skill emits one `spend-anomaly:<today>` card when today's cost is
  flagged vs the trailing 14-day median (needs-you when escalated); it auto-resolves once the day
  rolls past or the reading is no longer flagged (`server/briefing-resolve.ts`). Budget-posture is
  NOT emitted yet: the monthly budget is browser-local, so the runner has no server-visible source
  (CHI-366 follow-up moves it server-side; then the budget card slots in the same way).
- **Run-now** spawns the headless runner (assembles the snapshot from the adapter slices, keeps the
  `live-data.json` filename, spawns `claude -p --allowedTools Read,Glob,Grep` from an isolated runner
  cwd). Demo-refused (409); the dormant launchd template is NOT installed this phase (no duplicate
  daily run).

**CHI-323 sign-off (organ 1f):** same phase-1 delegation. The disclosed briefing spend-card gap was
the one named per-surface gap the plan required; it closed under CHI-324 2i (spend-anomaly cards).

### `/memory` — ops surface (hub-conditional, `MemoryPage.tsx`, CHI-323 3e)

Reading order: header (`MEMORY` + note/link/tier counts + communities legend) → the Nebula canvas
(left) + a side rail (right: node inspector + scope readout).
- **V2 Nebula** (`register.ts` MEMORY_REGISTER_NAME="v2", Chi's Round-4 pick): a 3D force-graph
  (`MemoryGraph.tsx`, `react-force-graph-3d` + `three`, **lazy-loaded** so three.js stays out of the
  entry chunk), colored by deterministic community (hub-attenuated label propagation), flow-arc
  edges, deep-space atmosphere, idle drift (disabled under `prefers-reduced-motion`).
- **Confidentiality**: the server slice walks the whole markdown corpus but hard-prunes
  confidential/next-ventures before reading, emits titles/paths only (NEVER body text), lstat-only,
  and is read-only (deletion/degree snapshots are opt-in, never enabled here).
- **Interactions**: click a node → inspector (name/kind/tier/path/last-touched); double-click or Open
  note → `POST /api/open-file` (bounded HARD to a `.md` under the live hub root, never a
  confidential segment; demo-refused; macOS `open`).
- **Demo**: a synthetic 27-node graph (`data/memory.demo.json`, generated from a temp hub so its
  shape always matches the real slice); every real-state action fail-closes.
- **Scope-suggest (CHI-339, shipped)**: the disclosed 1g gap is closed. The `memory-scope` gate
  surface (`server/gate/surfaces.ts`, schema from 1b) targets `${HOME}/.chronicle/memory-scope.json`;
  `collectMemoryGraph` reads it via `loadMemoryConfig` (`server/hub/slices/memoryscope.ts`), and the
  heavy-slice freshness signature folds in the config file's mtime so a confirmed edit takes effect on
  the next memory read. A headless-claude runner (`scripts/run-scope-suggest.ts`, ported from Varde,
  same seam as `run-briefing.ts`) walks the hub's top-level structure NAMES ONLY (never file
  contents) and proposes a living/historical/excluded mapping, kicked by
  `POST /api/memory/scope-suggest` and polled via `GET /api/memory/scope-suggest/status` (async
  single-flight, mirroring the briefing run/run-status pair). The suggestion only ever becomes a
  write through the existing `gatePropose('memory-scope', ...)` confirm-card flow — the route itself
  never writes. `ScopePanel` (`src/components/memory/ScopePanel.tsx`, a "Manage scope" affordance on
  the `.memory-scope` side panel) renders the current scope, a hand-edit form, and the AI-suggest
  button, all Chronicle-native CSS (ported from Varde's Tailwind original). Demo-refused (409), same
  posture as every other gate write on this page.
- **VIZ NOTE**: the Nebula 3D canvas is self-contained WebGL (theme-independent), ported from Varde's
  V2 register pixel-intact; the surrounding page shell is Chronicle-native (consistent with the other
  organs). React-19 compat verified (D4 spike): Varde ships the same React 19 + Vite 8 + rfg3d/three
  stack; no shim. WebGL pixels are not e2e-asserted (headless GL is unreliable); the release walk
  runs /memory with a software-GL flag (1h).

**CHI-323 sign-off (organ 1g):** same phase-1 delegation; the Nebula pixels are Chi's viz sign-off
(D4) reviewed live before merge.

### `/records` — ops surface (hub-conditional, `RecordsPage.tsx`, CHI-324)

The append-only hub records, via the new `records()` adapter slice (reads `records/*.jsonl`).
Renamed from "Ledger" per Chi's growth requirement (CHI-313/314): the surface is a record BROWSER,
not one ledger.

Reading order: eyebrow `RECORDS` + a record-TYPE switcher (boxed `.tabs` chrome) → the active
type's table.
- **Type switcher**: phase 2 ships EXACTLY ONE type, **Sessions**. Future types (Decisions from
  `records/decisions.jsonl`; Wiki sources; CHI-314 contacts/operations) are each a switcher entry +
  a contract line with ZERO new IA — do NOT build them in phase 2.
- **Sessions type** (`records/sessions.jsonl`): a table **Date · Session ID · Repo · Focus**,
  newest first, NO rangebar. A text filter + repo chips. Click-to-extend `N more` (window-btn
  pattern). The session id renders as its FULL id (never truncated); clicking it copies the full id
  to the clipboard (brief `copied` feedback) — a copy affordance, not a link, so a non-imported id
  is never a dead link. (Chi, 2026-08-26.)
- **Hub-conditional**: same wholesale nav toggle as the other ops organs — the `≡ Records` nav item
  + route render only when `/api/hub/status` reports present (live or demo), hidden when absent.
- **Demo**: synthetic session-ledger rows from the demo `records()` slice.

**CHI-324 sign-off:** landed under the consolidated phase-2 sign-off paragraph at the top of this
file (D3 Fable design session, artifact `06128eb0…`, approved 2026-08-26).

**CHI-339 sign-off (scope-suggest fast-follow):** self-signed under the same CHI-323 phase-1
delegation — it closes the disclosed gap on this same surface, no new IA.

## Pin inventory (each enumerable → its guarding e2e test — the contract self-audits)

| Enumerable / shape fact | Guarding test |
|---|---|
| Sidebar = exactly Insights + Projects, no Home entry, no `⌂` (hub ABSENT — the default e2e harness) | `test/e2e/home.spec.ts` — "sidebar top nav has exactly Insights and Projects, no Home entry" |
| Ops nav (Modules) hidden + `/api/hub/modules` absent-sentinel when the hub is absent | `test/e2e/ops-modules.spec.ts` — "the Modules nav item is not rendered and the API returns the absent sentinel" |
| `/modules` renders the registry table + contract detail from the hub (demo synthetic) | `test/e2e/ops-modules.spec.ts` — "ops nav shows Modules and the page lists the synthetic modules with a contract detail" |
| Modules slice reads only `product-contract.md`, refuses confidential/next-ventures paths | `test/hub-modules.test.mjs` (node) — parseContractCell refusal cases + parseModulesTable |
| Safety nav hidden + `/api/hub/safety` absent-sentinel when the hub is absent | `test/e2e/ops-safety.spec.ts` — "no Safety nav item; /api/hub/safety returns the absent sentinel" |
| `/safety` posture tiles + accepted-gaps render (demo); gate controls inert in demo | `test/e2e/ops-safety.spec.ts` — "posture tiles + accepted-gaps render; gate controls are read-only in demo" |
| Confidential marker drill-down is 403 by default (never served on the public build) | `test/e2e/ops-safety.spec.ts` + `test/hub-safety.test.mjs` — confidentialMarkersEnabled gating |
| Safety slice emit-allowlist (no innocuous-key creds leak), markers as COUNTS only | `test/hub-safety.test.mjs` (node) — allowlist + planted-secret + counts assertions |
| Gap launcher refuses demo (409); prompt built server-side | `test/e2e/ops-safety.spec.ts` + `test/hub-safety.test.mjs` |
| Jobs nav hidden + `/api/hub/jobs` absent-sentinel when the hub is absent | `test/e2e/ops-jobs.spec.ts` — "no Jobs nav item; /api/hub/jobs returns the absent sentinel" |
| `/jobs` unified list (launchd/cron/registry/template) + log-tail drill-in (demo) | `test/e2e/ops-jobs.spec.ts` — list renders + log drill-in tails the declared log |
| Job log tail opens only declared paths (browser sends id, never a path); tail-capped | `test/hub-jobs.test.mjs` (node) — job-logs reads only the declared path + TAIL_LINES |
| Pause/resume refused in demo (gate inert) | `test/e2e/ops-jobs.spec.ts` — "pause is refused in demo" |
| Briefing nav hidden when the hub is absent | `test/e2e/ops-briefing.spec.ts` — "no Briefing nav item" |
| `/briefing` renders cards; a card action moves state (two-file split) | `test/e2e/ops-briefing.spec.ts` + `test/briefing.test.mjs` (applyCardAction/resolveCards) |
| Briefing run refused in demo (409) | `test/e2e/ops-briefing.spec.ts` + `test/briefing.test.mjs` |
| Memory nav hidden + `/api/hub/memory` absent-sentinel when the hub is absent | `test/e2e/ops-memory.spec.ts` — "no Memory nav item; /api/hub/memory absent sentinel" |
| `/memory` mounts the Nebula canvas with no page errors; shell + scope render (demo) | `test/e2e/ops-memory.spec.ts` — "shell renders (header + scope + canvas) with no page errors" |
| Memory slice prunes confidential/next-ventures + emits NO body text (whole-corpus walk) | `test/hub-memory.test.mjs` (node) — hard-prune + no-body-text pins |
| open-file bounded to a hub `.md`, never confidential; demo-refused | `test/e2e/ops-memory.spec.ts` + the route's path guard |
| `∴ Ask` entry hidden + `/api/ask/status` `enabled:false` + `/ask` fails soft when Ask is off (default) | `test/e2e/ask.spec.ts` — "no ∴ Ask sidebar entry…" + "navigating to /ask fails soft" |
| Ask gating formula `enabled === toggleOn && claudePresent && !demo` never drifts | `test/e2e/ask.spec.ts` — the formula assertion in both describes |
| `POST /api/ask` refused with 409 in demo; `∴ Ask` never shows in demo | `test/e2e/ask.spec.ts` — "POST /api/ask returns 409 (nothing spawns)" |
| Ask runner SELECT-only guard (accept SELECT/WITH, reject writes/DDL/PRAGMA/ATTACH/multi-statement/comment-smuggle) + deduped cost views reconcile | `test/ask.test.mjs` (17 unit tests) |
| Scope-suggest walks structure NAMES only, hides confidential/next-ventures; validated tier mapping | `test/scope-suggest-route.test.mjs` (node) — `hubStructure`/`validateSuggestion` pins |
| `loadMemoryConfig` per-tier fallback to defaults on an absent/partial/malformed config file | `test/memoryscope-config.test.mjs` (node) |
| ScopePanel renders the current scope; Suggest scope refused in demo (409, no confirm card) | `test/e2e/ops-memory.spec.ts` — "ScopePanel (memory scope-suggest, CHI-339)" |
| Hub tabs = Overview / Explore / Content / Spend / Sessions (exactly five, CHI-324), Overview default | `test/e2e/home.spec.ts` — "the hub at / shows exactly Overview / Explore / Content / Spend / Sessions tabs" |
| Window toggle = Today / 7d / 30d / 90d / All (exactly five) | `test/e2e/home.spec.ts` — "the window toggle on / has exactly…" |
| `/insights` (and `?tab=`) redirects to `/` | `test/e2e/home.spec.ts` — "/insights redirects…" + "…?tab=explore…" |
| Overview DOM order KPIs → activity → anomaly tile → charts, no ledger, no top-sessions-by-cost (CHI-324) | `test/e2e/home.spec.ts` — "Overview reading order KPIs → activity → anomaly → charts" |
| Activity block Today-only; anomaly tile persists on 7d (CHI-324, was burn) | `test/e2e/home.spec.ts` — "window toggle to 7d hides the Activity block, anomaly tile persists" |
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
| Anomaly tile headline = ratio + flag (`high` text label), support = absolute `$current vs $baseline`, + movers/flagged-days/Lane-C lines (CHI-324, keeps D6 anatomy) | no dedicated e2e pin (no probe touches `.burn-now` internals); visual conformance judged at the design-QA walk vs the D3 artifact |
| Spend tab renders budget band → chart row (spend-over-time + spend-by-model/Sources) → plan windows → efficiency → skills/mcp → proxy lane; NO anomaly card (Overview-tile-only), NO Spend-by-model on Overview (CHI-324) | `test/e2e/spend-tab.spec.ts` — "Spend tab reading order + budget band present" |
| Spend-over-time stack toggle = exactly [project \| provider]; toggling repaints series without cross-mode color bleed; median dash on the same y-scale, no flagged-day chart markers (CHI-324 2d) | `test/e2e/spend-tab.spec.ts` — "spend chart stack toggle is project/provider, one y-axis, no flagged markers" |
| Budget editor writes only through the `budget-config` gate surface (diff card, never a raw write) | `test/e2e/spend-tab.spec.ts` + `test/gate-budget.test.mjs` — budget-config validate + gated write |
| Sessions tab = [human\|all] toggle + 3-up aggregates + ONE flat sessions table (chips cost\|duration\|recent, cost default), click-to-extend (CHI-324) | `test/e2e/sessions-tab.spec.ts` — "Sessions tab toggle + aggregates + one flat table" |
| Exactly two session lists product-wide: /projects ledger + Sessions tab (no third) | `test/e2e/sessions-tab.spec.ts` — "no day sub-headers in the Sessions-tab table (grouping is ledger-only)" |
| Records nav hidden + `/api/hub/records` absent-sentinel when the hub is absent (CHI-324) | `test/e2e/ops-records.spec.ts` — "no Records nav item; /api/hub/records returns the absent sentinel" |
| `/records` renders the sessions-type table (Date / Session ID / Repo / Focus) from the hub (demo); type switcher present | `test/e2e/ops-records.spec.ts` + `test/hub-records.test.mjs` — records slice parse + newest-first + imported-id link |
| Explore dimensions include `mcp` (per-server, calibrated) + `provider` (model vendor) (CHI-324 D6) | `test/explore-mcp-provider.test.mjs` (node) — mcp derivation + provider mapping + calibrated flag |
| Briefing spend cards light up (spend domain accepted; the phase-1 gap closed, CHI-324 2i) | `test/briefing.test.mjs` — "validator accepts a spend-domain card" + the removed `.briefing-scope` gap note |
| Explore session grouping / Other segment | `test/e2e/explore.spec.ts` |
| Content characteristics: 7 shares at all/project scope, 6 session facts at session scope, merged into one "What your usage says" card (D4) | `test/e2e/content-characteristics.spec.ts` |
| Playback selection drives panels | `test/e2e/playback.spec.ts` |
| InfoTip opens downward, closes, no viewport clip | `test/e2e/infotip.spec.ts` |
