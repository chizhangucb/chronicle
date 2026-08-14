# Chronicle design rubric

Checked-in, Chronicle-specific judge input for the release product walk (spec `records/plans/
2026-08-12-chronicle-quality-pass-design.md` §5.2; C4 Task 19 runs the audit). Distilled ONCE
(2026-08-12, C2 Task 11) from three design skills — `frontend-design` (aesthetic direction/
typography), `dataviz` (charts/heatmaps/stat tiles), `ui-ux-pro-max` (UX guidelines/interaction
states) — plus Batch B's 8-category aesthetic rubric and the quality-pass spec's 4 lenses. The
skills GENERATE; this file JUDGES. Every rule below is phrased so a screenshot or a DOM/CSSOM
probe can return a verdict — not aspirational prose. Update this file, not ad-hoc call-site
judgment calls, when a new rule is needed; CLAUDE.md's UI/UX design-QA section points here.

## The 4 lenses

Every walk finding is tagged with the lens it violates (a finding can hit more than one):

- **Function** — does the interaction actually work (click drives state, popover opens, search
  returns results)? Probe: real Playwright interaction, not just a static screenshot.
- **Responsiveness** — does the surface hold up at all three reference widths with no overflow,
  no clipped popover, no crossed element? Probe: DOM/CSSOM assertions at each width (see below).
- **Data-scale** — does the surface still render correctly and performantly on a big/real dataset
  (5k+ messages, 100+ subagents), not just the small dev fixture? Probe: assertions against the
  big-session fixture's ground-truth constants (`FIXTURE_SUBAGENT_COUNT`, `FIXTURE_MAIN_MESSAGES`
  in `test/fixtures/gen-big-session.mjs`) plus a warm-request perf budget.
- **Product completeness** — does the surface deliver what the spec/product decision promised
  (not just "doesn't crash")? Probe: feature-level checklist against the relevant spec §2.x
  decision, or against this rubric's per-surface checklist below.

## Per-surface checklist

Run every item against the live app at all 3 reference widths (see Responsiveness policy) unless
marked "layout-independent." Tag findings with the Batch B 8-category rubric AND a lens (above).

### Global chrome (App.tsx sidebar, top bar, breadcrumb)
- [ ] Exactly one collapsible left sidebar; collapse state persists across reload (localStorage).
- [ ] Top-bar Search (⌕) and "+ Import Sessions" render on every route (Home, project, session).
- [ ] LIVE pill renders only when a live SSE session is open; absent otherwise.
- [ ] No horizontal scrollbar on `document.documentElement` at any of the 3 reference widths.
- [ ] Every icon in chrome is the mono glyph vocabulary (below) or an SVG — zero colored emoji.

### Home = the Insights hub (`HomeDashboard.tsx`) + Projects (`ProjectsPage.tsx`)
Product shape enumerated in `.claude/product-contract.md` — judge against it (IA-conformance lens).
- [ ] `/` Overview reading order top→bottom: KPI strip → Activity block (Today only) → Burn tile →
      Insights charts → Recent-sessions ledger LAST. Exactly one KPI strip, one `/api/insights` fetch.
- [ ] Tabs Overview / Explore / Content and a five-option window toggle (Today/7d/30d/90d/All) present.
- [ ] `/projects` is the dense `.rail-proj` LIST (pdot · name · live dot … count · gear menu; meta =
      branch/"needs association" · relative time) — NEVER the bordered `.projects-grid` card treatment.
- [ ] Ledger + project select mode: rows/day-headers become checkboxes; delete is a two-step INLINE
      confirm bar — `document.querySelectorAll('.confirm-bar, [class*="confirm"], .menu-confirm')`
      finds it, `window.confirm`/`alert`/`prompt` are never called (grep, not just runtime — see
      App-wide invariants).
- [ ] Both surfaces reflow with no horizontal overflow at 1024px (ledger + rail-list).

### Project detail / Insights hub (`ProjectDetail.tsx`, `HomeDashboard.tsx`)
- [ ] Overview/Explore/Content/Sessions tabs (project) or Overview/Explore/Content tabs (the `/`
      Insights hub) all render without a client error at each reference width.
- [ ] KPI/stat tiles: every numeric leaf reports `getComputedStyle(el).fontVariantNumeric`
      containing `"tabular"` (see Alignment policy).
- [ ] No KPI tile's right edge (`getBoundingClientRect().right`) exceeds its row container's
      right edge at any reference width (LAYOUT/BUG).
- [ ] No stat is shown twice on the same page without a visibly distinct label explaining the
      difference (DEDUP).
- [ ] Working Rhythm calendar/heatmap: cells keyboard/hover-inspectable, legend present (Chart
      rules below).

### Session view (`SessionView.tsx`) — Overview / Playback / Refine / Security Check
- [ ] Sidebar rail registers exactly the modes documented in the file (`onRailChange`); ⌘1–⌘3
      switch modes; breadcrumb session switcher remounts the view cleanly (keyed by session id).
- [ ] Playback: selecting a timeline point drives the panel(s) below it (Function lens — a real
      click, not a static screenshot).
- [ ] Playback panels (code/file-tree, conversation) are resizable within their documented floors
      and never overflow their container at any reference width.
- [ ] Subagents card total matches the imported session's real subagent count (Data-scale lens —
      on the big fixture this must equal `FIXTURE_SUBAGENT_COUNT`).
- [ ] Security Check tab lists interceptions/redactions without leaking raw secret text.

### Modals, dropdowns, toasts (Radix primitives)
- [ ] `.modal` self-centers via a **static** `transform: translate(-50%,-50%)` property on the
      class itself (not only inside `@keyframes modal-in`'s `to` state) — after the 200ms
      `modal-in` animation finishes, `getComputedStyle(el).transform` must still center it, not
      revert to `none`.
- [ ] Every modal offers a close affordance (✕) reachable by keyboard; Escape closes it.
- [ ] Toasts auto-dismiss; if app logic implies a non-default window, `duration={N}` is passed
      explicitly (Radix `Toast.Root` defaults to 5000ms).

### Charts (any Recharts or hand-rolled SVG/CSS visualization)
- [ ] See Chart rules below — treat as its own checklist section.

## Alignment policy

- **Text is left-aligned.** Never center body text or table cell prose.
- **Numerics are right-aligned with `font-variant-numeric: tabular-nums`.** Use the shared
  `.num-col` class (`src/styles.css`) for any table/list column of numbers; do not hand-roll
  `text-align: right` + a separate tabular-nums declaration at a call site.
  - Checkable: for every element matching a numeric-column selector, `getComputedStyle(el)
    .textAlign === 'right'` AND `getComputedStyle(el).fontVariantNumeric` contains `'tabular'`.
- **Timestamps are right-aligned in a fixed-width slot that cannot overflow the row.** Use the
  shared `.ts-col` class (`text-align: right; width: 9ch; overflow: hidden; white-space: nowrap`)
  — a timestamp cell never wraps to a second line or pushes a sibling column off the row.
  - Checkable: `getComputedStyle(el).whiteSpace === 'nowrap'` AND the cell's `scrollWidth <=
    clientWidth` is false is disallowed (i.e. no visible overflow) OR text is truncated by design
    (ellipsis), never wrapped.
- **Money follows ONE precision policy via `src/format.ts`.** `fmtInt`/`fmtMoney(dp)`/`pluralize`
  are the only money/number formatters — 0dp grouped (`fmtMoney(n, 0)`) for KPIs/axes/summaries/
  bar labels, 2dp grouped (`fmtMoney(n, 2)`) for detail tables/tooltips/per-row cost. A raw
  `` `$${v}` `` template literal or a bare `.toFixed()` call on a money value anywhere in `src/`
  is a P0 finding by construction (grep for it) — **documented exception:** `fmtLaneC` in
  `src/HomeDashboard.tsx` (proxy-lane billed spend), which deliberately falls back to raw
  `.toFixed(4)`/a literal `<$0.0001` string for sub-cent values, per its inline comment ("never
  round a non-zero spend down to a misleading $0.00"); this is a known, comment-documented
  carve-out, not a new finding — mirrors the `--heat-axis-offset` token carve-out below.
- **`font:` shorthand trap.** Any CSS rule that sets the `font:` shorthand resets
  `font-variant-numeric` to `normal`; a rule combining `font:` with a numeric column MUST re-state
  `font-variant-numeric: tabular-nums;` as a trailing declaration in the same rule. Checkable by
  the same `fontVariantNumeric` probe above — it will read `"normal"` on a broken rule.

## Container policy

- **No fixed pixel widths for content panes.** Grid/flex layouts use `minmax()`/`fr` units; a
  content pane's width comes from its container, not a literal `width: NNNpx` (exception: fixed
  chrome like the sidebar rail, which is a deliberate constant, not "content").
- **Flex/grid children that can scroll internally set `min-width: 0` (or use the shared `.pane`
  class: `min-width: 0; overflow: auto`).** Without it, flexbox's automatic minimum content size
  keeps long unwrapped content (a long commit line, an unbroken token) from ever triggering
  `overflow: auto` — the child instead pushes its container wider than the viewport.
  - Checkable: for any element intended to scroll its own content, `getComputedStyle(el).minWidth
    === '0px'` (or inherits `.pane`) AND `getComputedStyle(el).overflow` is `auto`/`scroll`.
- **Side panels are resizable within documented clamp floors**, never able to shrink to 0 or grow
  past their sibling's minimum (Playback's code/file-tree split is the reference implementation).
- **Duplicate CSS selectors are a container-policy bug, not just a style bug.** The cascade
  silently collapses to the LAST matching rule (the historical `.hbar`/`.rangebar` scar) — before
  adding a new rule under an existing selector name, grep the COMBINED diff for that selector; if
  it already exists, extend it in place. Scope a per-surface block under its page-root class
  (`.project-detail` / `.insights-page` / `.overview-page`) when two surfaces might both claim a
  shared class name.

## Popover policy

One InfoTip implementation (`src/InfoTip.tsx`), zero per-callsite hacks. Validated against the
Radix `Popover.Content` docs (Task 9, C1): `avoidCollisions` is a **single switch for both axes**
— turning it on does not just add horizontal shift, it also re-enables upward flip on the side
axis. There is no documented per-axis flip toggle (`sticky` only governs the align axis). So:

- **`avoidCollisions={false}` always, `side="bottom"` always.** A popover must never flip above
  its trigger — Radix is not asked to reposition the side axis at all.
- **Horizontal (align-axis) clamping is manual**, not delegated to Radix's `avoidCollisions`: an
  unanimated wrapper `<div>` around the bubble content applies `transform: translateX(...)` so the
  clamp transform and the bubble's CSS entrance animation's `transform` live on different DOM
  nodes and compose instead of overwriting each other (a CSS Animation origin outranks a plain
  inline style on the same property/element for the animation's duration).
- **`onOpenChange` must be wired** on every `Popover.Root` — Radix's internal Escape/outside-click
  dismissal calls it to request a close; a controlled `open` prop with no `onOpenChange` silently
  drops that request and the bubble never closes.
- **`onCloseAutoFocus={(e) => e.preventDefault()}`** on `Popover.Content` when the trigger also
  opens `onFocus` (keyboard accessibility) — otherwise Radix's default post-close focus-return
  re-fires the trigger's `onFocus` handler and the popover reopens itself immediately after close.
- Checkable (mirrors `test/e2e/infotip.spec.ts`): at each reference width, open the right-most
  trigger on a KPI row → the bubble's `getBoundingClientRect()` is fully inside the viewport
  (`x >= 0`, `x + width <= innerWidth`) AND its `top >= trigger.bottom` (still opened downward,
  never flipped above). After outside-click / Escape / hovering 5 tips rapidly then moving off,
  `document.querySelectorAll('.info-bubble').length === 0`.
- `.info-bubble` is 250px wide so long explainers stay short; i18n explainer keys are the full
  English sentence (`src/i18n.ts` — English is the dictionary key itself).

## Reference widths

Every surface is judged at all three (spec §4, `test/e2e/helpers.ts` `WIDTHS`):

| Width | Represents |
|---|---|
| 1024px | small laptop |
| 1366px | common desktop (also the Playwright default test viewport) |
| 1728px | wide desktop |

Pass condition at each width, on every surface: `document.documentElement.scrollWidth <=
window.innerWidth` (no horizontal overflow) AND no element's `getBoundingClientRect().right`
exceeds `innerWidth` AND no open popover/menu is clipped by the viewport edge.

## Spacing scale

Fixed step scale in `src/styles.css` `:root` — `--gap-1: 4px; --gap-2: 8px; --gap-3: 12px;
--gap-4: 16px; --gap-5: 24px;`. Label↔value gaps and item↔item gaps draw from this scale, not
arbitrary px values.

- **SPACE (Batch B category):** a label must never run directly into its value with no gap
  (`margin`/`gap` of 0 between a `.label`-class element and its adjacent value) — checkable via
  computed `gap`/`margin-right` matching one of the 5 scale steps, not `0px`.
- **RHYTHM (Batch B category):** repeated structural gaps (card padding, list-item spacing, KPI
  row gaps) within one surface use the SAME step consistently — checkable by collecting every
  matching gap's computed pixel value on a surface and confirming they cluster to a single
  `--gap-N`, not a scatter of one-off values.
- New spacing needs pick the nearest existing step; a genuinely new value is a deliberate
  exception (like `--heat-axis-offset`, a documented layout offset), never silent px drift.

## Chart rules (distilled from `dataviz`)

Applies to every Recharts or hand-rolled SVG/CSS chart, heatmap, or stat tile.

- **Form fits the job.** Magnitude → bar/line; identity → categorical color; polarity →
  diverging; a single number → a stat tile, not a chart. Checkable: does the chosen mark type
  match the data's job, per `dataviz`'s `choosing-a-form` heuristic — a subjective call, but the
  mismatch cases (dual-axis, pie with >5 slices) are objectively checkable (see below).
- **One axis, always.** A dual-axis chart (two y-scales on one plot) is a P0-by-construction
  finding — checkable by grepping chart configs for a second `yAxisId`/right-side axis on the same
  plot area.
- **Categorical color is fixed order, never cycled**, drawn from `--c1..--c5`. A filter that
  changes the series count must not repaint the surviving series to new colors — checkable by
  diffing a series' assigned color before/after toggling a filter.
- **Sequential = one hue light→dark; diverging = two hues + neutral gray midpoint.** Never a
  rainbow scale; never a hue (not gray) at a diverging chart's zero/midpoint.
- **No pie/donut for more than 5 categories** — switch to a bar chart. Checkable: count chart
  segments; >5 on a pie/donut is a finding.
- **Legend present for 2+ series, direct-labeled for ≤4** (a single series needs no legend box —
  the chart title names it). Checkable: DOM query for a legend element when `seriesCount >= 2`.
  Identity is never conveyed by color alone — a legend, icon, or text label always accompanies it.
- **Tooltip/hover layer on every interactive chart** except a bare stat tile with no plot —
  crosshair+tooltip on line/area, per-mark tooltip on bar/dot/cell. Checkable: hovering a mark
  produces a visible tooltip element within the interaction window.
- **Axis labels are readable, not rotated/truncated at any reference width**; large datasets
  (1000+ points) are aggregated/sampled, not rendered raw. Checkable: at 1024px, no axis tick
  label's bounding box overlaps its neighbor.
- **Numbers on axes/labels follow the money/int policy above** (`fmtInt`/`fmtMoney` — never a
  raw template).
- **Status colors (`--ok`/`--warn`/--danger`) are reserved** for good/warning/critical state and
  never reused as a categorical "series N" color; they always ship with an icon or text label,
  never color alone.

## App-wide invariants (regression guards — grep or DOM-probe to confirm)

- **Zero `window.prompt/confirm/alert`** in app code (`test/no-window-dialogs.test.mjs` guards
  it) — inline edit/confirm patterns only.
- **Exactly one magnifier glyph `⌕`** across the app.
- **Mono glyph vocabulary, no colored emoji, in chrome or page content.** The canonical set
  (extend this list when adding a new one, don't invent a parallel vocabulary): `⌕`=search
  `⧖`=time `◫`=project `▤`=chat/session `⬚`=overview `◈`=security `∑`=insights `⚙`=settings
  `⌫`=destructive `✕`=close (distinct from `⌫`) `⛓`=causality (`src/session/MessageRow.tsx`)
  `↶`/`↷`=undo/redo (`src/RefineMode.tsx`). This list is canonical but not exhaustive — any
  other MONO glyph used consistently for one meaning is legitimate; a COLORED emoji is not, full
  stop. **Known open item:** `src/kinds.ts` `KIND_ICON` still maps `user`/`thinking`/`tool_use`
  to colored emoji (👤/💭/🔧), rendered in every Playback row via `src/session/MessageRow.tsx`
  — a known, tracked gap (not a fix for this task; the C4 walk adjudicates whether to mono-ify
  `KIND_ICON`, since it's a product call, not a rubric call). A walk judge should treat this as
  the KNOWN gap, not report it as a novel finding, unless re-triaging it at C4.
- **Design tokens only** — never re-tone `:root` (`--bg0/1/2`, `--border(-strong)`, `--ink/-2/-3`,
  `--brass(-text)`, `--ok/--warn/--danger`, `--c1..--c5`); a genuinely new token (like
  `--heat-axis-offset`) is a documented layout offset, not a color re-tone.
- **Chat-type labels have one source of truth**: `src/kinds.ts` `KIND_LABEL`/`KIND_ICON` — never
  an inline label string for a message kind.

## Severity rubric

Every finding from a §5.2 walk (or an ad-hoc audit using this rubric) gets exactly one severity.
Publish is blocked while any **P0** or **P1** finding is open (spec §5.2/§8); **P2** is logged to
the backlog and does not block.

- **P0 — blocks publish immediately.**
  - Any lens = Function failure on a primary flow (click doesn't drive state, popover never
    closes, search returns nothing, import fails).
  - Any Responsiveness violation at a reference width: horizontal overflow, an element crossing
    the viewport edge, a clipped/flipped popover.
  - Any Data-scale failure on the big fixture: wrong subagent/message count, a page that fails to
    render or times out on 5k+ messages / 100+ subagents.
  - A raw `` `$${v}` ``/`.toFixed()` money template, a `window.prompt/confirm/alert` call, a
    dual-axis chart, or any other rule above marked "P0-by-construction."
  - A DEDUP/AFFORD violation that actively misleads (two numbers that look like the same metric
    but disagree; a control with no visible affordance for a destructive action).
- **P1 — must fix before this release, does not need to stop mid-development.**
  - A Product-completeness gap: a spec §2.x decision only partially implemented, or a per-surface
    checklist item above unchecked.
  - A NUM/SPACE/RHYTHM/DISTINCT violation visible on a primary surface (Home, Insights Overview,
    session Overview) — e.g. a numeric column not right-aligned/tabular, an inconsistent gap
    scale on a KPI row, a source pill styled identically to a project pill.
  - A chart missing its legend/tooltip layer, or exceeding the 5-slice pie limit.
  - A popover-policy or container-policy violation on a secondary surface (reachable but not
    default-view).
- **P2 — backlog, does not block.**
  - A cosmetic-only BUG/LAYOUT nit on a rarely-visited surface (stray 1-2px gap, a slightly
    unbalanced span) with no functional or data impact.
  - A documented, deliberate deferral (matches the "minor (deferred)" pattern in
    `.superpowers/sdd/*/progress.md`) — noted for a future pass, not silently dropped.
  - A style-preference call where the rubric doesn't give a hard rule (e.g. "could this hierarchy
    be a little clearer") — worth a note, not a blocker.

Every P0/P1 finding must include: file/component, the specific probe or screenshot that surfaced
it, the lens(es) it violates, and the Batch B category tag. Findings append to hub records
(`records/brainstorms/`) in the Batch B table format, per the spec's §5.2 process.
