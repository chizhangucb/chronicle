// The definitions registry.
//
// ONE source for every metric definition in Chronicle. Both the small "ⓘ" tips
// scattered across the surfaces AND the /reference page read from here, so the
// page cannot drift from the console. Before this existed, every InfoTip
// carried its own inline string and a reference page would have been a second,
// silently diverging copy of them.
//
// i18n: `plain`/`good`/`tech` return ENGLISH SOURCE STRINGS. Callers pass
// them through the existing `t()` (src/i18n.ts is an English-keyed dictionary
// with English fallback), so tips behave byte-identically to before the
// migration and /reference translates exactly as far as the dictionary reaches.
// No new key namespace.
//
// `vars` exists for the handful of tips that quote a live number (a live count
// from the page, say). On /reference there is no call
// site, so `vars` is absent and the definition must still read correctly: write
// the fallback wording first, then the interpolation.
//
// The `retired` page is load-bearing, not a curiosity. Past releases
// deliberately dropped some surfaces; the decision was that the
// VOCABULARY survives even where the page did not, so someone who remembers a
// term can still find out what it meant.

export type DefPage =
  | 'overview' | 'spend' | 'sessions' | 'explore' | 'content'
  | 'projects' | 'session'
  | 'ask' | 'settings'
  | 'retired';

export interface DefVars { [key: string]: string | number | undefined }
export interface DefContext { vars?: DefVars }

export interface Definition {
  id: string;
  page: DefPage;
  title: string;
  /** The plain-language answer to "what is this number". English source string. */
  plain: (ctx: DefContext) => string;
  /** Optional "Good looks like: ..." line. */
  good?: (ctx: DefContext) => string;
  /** Optional provenance: which column, file or computation this comes from. */
  tech?: (ctx: DefContext) => string;
}

export const DEF_PAGE_ORDER: DefPage[] = [
  'overview', 'spend', 'sessions', 'explore', 'content',
  'projects', 'session',
  'ask', 'settings', 'retired',
];

export const DEF_PAGE_LABEL: Record<DefPage, string> = {
  overview: 'Insights · Overview',
  spend: 'Insights · Spend',
  sessions: 'Insights · Sessions',
  explore: 'Insights · Explore',
  content: 'Insights · Content',
  projects: 'Projects',
  session: 'Session view',
  ask: 'Ask',
  settings: 'Settings',
  retired: 'Retired (kept for the vocabulary)',
};

export const DEFINITIONS: Definition[] = [
  // ---- Insights / Overview ----
  {
    id: 'overview.spend',
    page: 'overview',
    title: 'Spend',
    plain: () => 'Priced locally from billed token counts, never billed data; sessions that started before the window but ran into it are pro-rated by their in-window token share. Toggle List price vs Billed in the topbar.',
    tech: () => 'session_model_cost, priced client-side from src/models.ts',
  },
  {
    id: 'overview.sessions',
    page: 'overview',
    title: 'Sessions',
    plain: () => 'Sessions imported from your coding tools that started or ran inside the selected window.',
  },
  {
    id: 'overview.tokens',
    page: 'overview',
    title: 'Tokens',
    plain: () => 'Input + output tokens billed across sessions in range; cache reads/writes are excluded from this count. % cached = cache reads ÷ (cache reads + fresh input).',
  },
  {
    id: 'overview.agent-active',
    page: 'overview',
    title: 'Agent active',
    plain: () => 'Agent Active sums every gap between messages except gaps before a typed human prompt, each gap capped at 10 minutes; gaps ending in a tool result are never capped.',
    good: () => 'High next to a low Engaged figure: the agent worked while you did something else.',
  },
  {
    id: 'overview.engaged',
    page: 'overview',
    title: 'Your engaged',
    plain: () => 'Engaged sums every gap between messages, each capped at 90 minutes; unlike Agent Active, it makes no distinction between agent work and your own pauses. Leverage = agent active ÷ engaged.',
  },
  {
    id: 'overview.tool-calls',
    page: 'overview',
    title: 'Tool calls',
    plain: () => 'Total tool invocations (Bash, Read, Edit, and so on) across all sessions in range. Each call and its result also carry token cost, which the Content tab breaks down.',
  },
  {
    id: 'overview.error-rate',
    page: 'overview',
    title: 'Error rate',
    plain: () => 'Share of tool results that returned an error (heuristic match on the result text). Delta compares the prior period of the same length.',
  },
  {
    id: 'overview.commits',
    page: 'overview',
    title: 'Commits',
    plain: () => 'Git commits within this window (a raw git log count), not filtered to only commits a tracked session caused.',
  },
  {
    id: 'overview.anomaly',
    page: 'overview',
    title: 'Spend anomaly',
    plain: () => 'Your spend in this window versus a baseline (Today uses the median of the last 14 complete days; longer windows use the prior period of equal length). Over 2x the baseline is flagged. The movers are the top project and model by spend in this window.',
    tech: () => 'src/insights/anomalyMath.ts, the one comparison method used console-wide',
  },
  {
    id: 'overview.cache-hit',
    page: 'overview',
    title: 'Cache hit rate',
    plain: () => 'Cache read ÷ (cache read + input): the share of prompt-side tokens served from cache instead of re-sent at full input price. Higher = cheaper turns.',
    good: () => 'High and stable. A sudden drop usually means the prompt prefix changed.',
  },
  {
    id: 'overview.messages',
    page: 'overview',
    title: 'Messages',
    plain: () => 'Every normalized event row (user, assistant, thinking, tool call, and tool result), not just human/assistant chat turns.',
  },

  {
    id: 'overview.provenance',
    page: 'overview',
    title: 'Sources strip',
    plain: () => 'Where the numbers above came from: how many sessions each tool contributed, when the last sync landed, and which cost basis is showing. The topbar sync pill says WHEN data last landed; this says WHAT is behind the figures.',
  },

  // ---- Insights / Spend ----
  {
    id: 'spend.cost-basis',
    page: 'spend',
    title: 'Cost basis (List price vs Billed)',
    plain: () => 'List price shows the metered list-price cost of every token (what an API caller would pay). Billed shows what you actually pay: models covered by your subscription (Claude tiers, gpt-5.6 / Codex) bill ~$0 under the plan, so their billed cost is 0.',
    tech: () => 'src/costMode.tsx, global and persisted; every dollar figure in the app prices at the selected mode',
  },
  {
    id: 'spend.budget',
    page: 'spend',
    title: 'Monthly budget',
    plain: () => 'The budget is always the current calendar month, independent of the window toggle above. Month-to-date, projection, and the pace / peak-day / per-active-day stats are all for this month.',
    tech: () => '~/.chronicle/config.json monthlyBudget, server-side so every surface that shows it reads the same number',
  },
  {
    id: 'spend.waste',
    page: 'spend',
    title: 'Waste signals',
    plain: () => 'List-price estimates of avoidable spend, not a bill. Right-sizing and cache-churn are heuristics; they cannot know whether a small premium reply needed frontier reasoning.',
  },
  {
    id: 'spend.priced-skills',
    page: 'spend',
    title: 'Priced skills',
    plain: () => 'Calibrated estimate: a turn’s spend is attributed to the skills and slash-commands it invoked, so a command that mostly sets up an expensive turn (for example /model) can carry a large figure. Read it as exposure, not a partition of spend.',
  },
  {
    id: 'spend.mcp-exposure',
    page: 'spend',
    title: 'MCP server turn $',
    plain: () => 'EXPOSURE, not the server’s own cost (MCP servers are free). It is the summed spend of the turns that used this server; a turn touching several servers is counted in each, so these do not sum to the day total.',
  },
  {
    id: 'spend.token-attribution',
    page: 'spend',
    title: 'Estimated token attribution',
    plain: () => 'Estimated from message text length, scaled to billed totals. Tool and skill token attribution is approximate.',
  },
  {
    id: 'spend.plan-windows',
    page: 'spend',
    title: 'Plan windows',
    plain: () => 'Your subscription quota windows: Claude 5h / 7d / top-tier-7d and Codex 7d. The Claude read is the one outbound call in Chronicle (your own quota, from api.anthropic.com, using Claude Code’s own token); it is on by default and switched off in Settings. Codex windows are read locally.',
  },

  // ---- Insights / Sessions ----
  {
    id: 'sessions.context-tokens',
    page: 'sessions',
    title: 'Ctx (context tokens)',
    plain: () => 'The size of the context window fed to the model for this session (input + cache-read), a proxy for how heavy the session ran.',
  },
  {
    id: 'sessions.minor',
    page: 'sessions',
    title: 'Minor sessions',
    plain: () => 'A session is “minor” only when it is small on BOTH axes: under ~5 min of agent-active time AND fewer than 10 messages, a true one-shot. Thresholds are adjustable in Settings. Minor sessions synced fine; they are just parked out of the main lists so they do not clutter them.',
    tech: () => 'server/noiseGate.ts; the AND gate is applied at import time',
  },
  {
    id: 'sessions.two-lists',
    page: 'sessions',
    title: 'Why there are two session lists',
    plain: () => 'The Projects ledger is for managing sessions (rename, remove, sync); the Sessions tab is for analyzing them (cost, duration, tools). Same rows, two jobs.',
  },

  // ---- Explore / Content ----
  {
    id: 'explore.rollup',
    page: 'explore',
    title: 'Rollup',
    plain: () => 'The time bucket the series is grouped into. When the requested rollup would produce too few or too many buckets for the window, Chronicle picks a workable one and says so.',
  },
  {
    id: 'content.characteristics',
    page: 'content',
    title: 'Content characteristics',
    plain: () => 'Each characteristic carries its own definition, supplied by the server alongside the number so the two can never drift. Hover the ⓘ on any characteristic row for its exact wording, including which sessions are left out of the share.',
    tech: () => 'server/content.ts Characteristic.info',
  },

  // ---- Projects ----
  {
    id: 'projects.cost',
    page: 'projects',
    title: 'Project cost',
    plain: () => 'Priced locally from billed token counts at list price, never billed data; sessions that started before the window but ran into it are pro-rated by their in-window token share.',
  },

  // ---- Session view ----
  {
    id: 'session.cost',
    page: 'session',
    title: 'Session cost',
    plain: () => 'Estimated from token counts. List price = metered list price; Billed = what you pay (subscription-covered models bill ~$0). Toggle in the topbar.',
  },
  {
    id: 'session.engaged',
    page: 'session',
    title: 'Engaged',
    plain: () => 'Engaged sums every gap between messages, each capped at 90 minutes; unlike Agent Active, it makes no distinction between agent work and your own pauses.',
  },
  {
    id: 'session.rename',
    page: 'session',
    title: 'Rename',
    plain: () => 'Renames in Chronicle only, independent of Claude Code’s /rename. The source transcript is never modified.',
  },
  {
    id: 'session.subagents',
    page: 'session',
    title: 'Subagent runs vs types',
    plain: () => 'A run is one subagent invocation (agent_id); a type (for example general-purpose) can have many runs. Turns are that type’s assistant messages across all its runs. Tokens are input + output across all its runs.',
  },

  // ---- Ask ----
  {
    id: 'ask.local',
    page: 'ask',
    title: 'How Ask answers',
    plain: () => 'Each answer is generated locally by your claude CLI, which may run only ONE tool: a read-only, SELECT-only query over ~/.chronicle/chronicle.db. No data leaves your machine. Dollar figures use the cost basis shown and reconcile with the Insights dashboards.',
  },

  // ---- Settings ----
  {
    id: 'settings.view-log',
    page: 'settings',
    title: 'Local view log',
    plain: () => 'Records which Chronicle surfaces you use (route, tab, time spent), tagged human or agent so automated runs do not read as yours. Stored only in chronicle.db on this machine, kept 180 days, and never sent anywhere.',
    tech: () => 'server/viewlog.ts; routes are stored as patterns (/session/:id), never as instances',
  },

  // ---- Retired: surfaces dropped by past releases ----
  // The surfaces are gone; the vocabulary survives, so a term you remember can
  // still be looked up. Each says plainly what replaced it.
  {
    id: 'retired.pinned-panels',
    page: 'retired',
    title: 'Pinned panels (retired)',
    plain: () => 'Chronicle could once promote a committed read-only SQL query over the contract_* views into a dashboard panel. Exactly one panel ever existed, "MCP tool calls by server", and that content is now a native feature on the Spend tab. The promote-to-panel mechanism itself is gone; the Explore tab covers ad-hoc querying.',
  },
  {
    id: 'retired.peek-drill',
    page: 'retired',
    title: 'Peek drill (retired)',
    plain: () => 'A quick preview of a session from a spend row. Dropped because Chronicle’s session Overview is a richer version of the same idea; a row click goes straight there.',
  },
  {
    id: 'retired.burn-tile',
    page: 'retired',
    title: 'Burn tile (retired)',
    plain: () => 'Chronicle’s original client-side spend-versus-baseline tile. Replaced by the Anomaly tile, which keeps the same anatomy and window rules but adds dimension movers and flagged days.',
  },
  {
    id: 'retired.proxy-lane',
    page: 'retired',
    title: 'Proxy lane (retired)',
    plain: () => 'A separate spend figure read from a local LiteLLM proxy’s billed-dollar log, shown as its own KPI tile and a slim row on Spend. Removed: Chronicle now shows one spend figure, estimated from your sessions, and reads no spend log outside its own data folder.',
  },
  {
    id: 'retired.machine-sessions',
    page: 'retired',
    title: 'Automation sessions (retired)',
    plain: () => 'A manifest of headless automation runs written by another tool, used to split the session count into human and automation and to bucket automation spend by job. Removed with the proxy lane: Chronicle counts the sessions it imports and nothing else.',
  },

  // ---- Retired: the Memory surface, dropped in the shrink (#219 / spec #215).
  // The 3D graph, lanes, notes browser and scope flow are gone; the vocabulary
  // stays findable for anyone who remembers a term. ----
  {
    id: 'memory.living-vs-records',
    page: 'retired',
    title: 'Memory · Living notes vs records',
    plain: () => 'Living notes (wiki pages, governance, skills, context, references, registry files) are maintained-in-place knowledge and are what gets measured. Records (decisions, sessions, brainstorms, reports, archives, sources) are dated history: evidence, never rot.',
  },
  {
    id: 'memory.freshness',
    page: 'retired',
    title: 'Memory · Freshness and stale',
    plain: (c) => `Age is days since a living note’s last edit; past ${c.vars?.thresholdDays ?? 30} days it counts as stale. Records never rot, so they are not in this count.`,
  },
  {
    id: 'memory.orphan',
    page: 'retired',
    title: 'Memory · Orphans and unlinked',
    plain: () => 'An orphan is a living note with zero links in or out AND zero touches in the selected window: unreachable and unused. Unlinked alone is a neutral count; a note your sessions touch daily is not orphaned.',
  },
  {
    id: 'memory.communities',
    page: 'retired',
    title: 'Memory · Communities',
    plain: () => 'Notes are colored by a deterministic community assignment computed from the link graph, so the same corpus always produces the same colors. The grouping is structural, not semantic: it reflects what links to what, not what the notes are about.',
  },
  {
    id: 'memory.confidential-pruning',
    page: 'retired',
    title: 'Memory · What the graph never shows',
    plain: () => 'Only titles and paths reach the browser, and confidential trees are pruned server-side before the graph is built. Note bodies are never sent.',
  },
  {
    id: 'memory.touches',
    page: 'retired',
    title: 'Memory · Touches and usage',
    plain: () => 'A touch is one deterministic use of a note in the window, from three channels: a session transcript that reads it, a wikilink that points at it, and a briefing that cites it. Knowledge nobody reads is storage, not memory.',
  },
  {
    id: 'memory.growth',
    page: 'retired',
    title: 'Memory · Growth and births',
    plain: () => 'A birth is a living note created in the window, read from the file birth time; records and machine output never count. The living base is the current total, and deletions accrue once two scans exist to diff.',
  },
  {
    id: 'memory.notes-browser',
    page: 'retired',
    title: 'Memory · The notes browser',
    plain: () => 'One searchable list of the notes behind the lanes, filtered by preset (touched, most connected, or orphaned) and by kind. A row opens the same inspect panel as clicking the node on the canvas.',
  },
  {
    id: 'memory.lenses',
    page: 'retired',
    title: 'Memory · Canvas lenses',
    plain: () => 'A lens recolors the graph to answer one question. Usage heat brightens the notes your sessions touched in the selected window and dims the rest; Orphans lights up living notes with no links and no touches. With no lens, color is the community grouping.',
  },
  {
    id: 'memory.full-lite',
    page: 'retired',
    title: 'Memory · Full vs Lite',
    plain: () => 'Full draws every node and link. Lite caps the draw to the most-connected notes so a very large graph stays at frame rate; nothing is deleted, only fewer are drawn, and the caption says how many.',
  },
  {
    id: 'retired.briefing',
    page: 'retired',
    title: 'Daily briefing (retired)',
    plain: () => 'A daily headless model run that wrote action cards about jobs, safety, coverage and spend, shown on their own page and as a band above the home numbers. Removed: the console it reported on is gone, and the spend half of it now lives on the Spend tab as the budget line and the flagged-day anomaly.',
  },
  {
    id: 'retired.home-bands',
    page: 'retired',
    title: 'Home bands (retired)',
    plain: () => 'Two rows that sat above the KPI strip on Insights: the briefing cards, and a five-domain status band echoing them. Removed with the briefing; the Overview now opens straight on the numbers.',
  },
  {
    id: 'retired.work-on-this',
    page: 'retired',
    title: '"Work on this" launcher (retired)',
    plain: () => 'A button on Safety that opened a Terminal with a review prompt typed but unsubmitted. Removed: Chronicle no longer launches other programs.',
  },
  {
    id: 'retired.modules-page',
    page: 'retired',
    title: 'Modules (retired)',
    plain: () => 'A page that listed the software modules described in a connected operations folder, with each module’s tier, purpose and a read-only view of its contract document. Removed because Chronicle no longer reads another project’s files. Nothing replaces it.',
  },
  {
    id: 'retired.jobs-page',
    page: 'retired',
    title: 'Jobs (retired)',
    plain: () => 'A page that listed every scheduled task on the machine (launchd, crontab, registry entries and repo templates) with its live state, a log tail and pause/resume. Removed because scheduling other people’s work was never part of reading your coding sessions. Use the scheduler your machine already ships.',
  },
  {
    id: 'retired.records-page',
    page: 'retired',
    title: 'Records (retired)',
    plain: () => 'A page that read an append-only session ledger and decision log kept outside Chronicle, showing date, session id, repo and focus. Removed with the rest of the external-folder coupling; Chronicle’s own Sessions tab covers the sessions it imported.',
  },
  // ---- Retired: the Safety ops surface, dropped in the shrink (#221 / spec
  // #215). The egress-gate panels and the routing roster read another
  // project's folder and are gone; the vocabulary stays findable. ----
  {
    id: 'retired.safety-gate',
    page: 'retired',
    title: 'The egress gate (retired)',
    plain: () => 'A policy that sat in front of anything an agent sent, published or spent: every gated call passed an intent check and a confidentiality scan before leaving the machine, and OFF meant fail-closed. It was configured and enforced outside Chronicle; the page that read its posture is gone.',
  },
  {
    id: 'retired.safety-markers',
    page: 'retired',
    title: 'Confidentiality markers (retired)',
    plain: () => 'Phrases the egress gate’s confidentiality scanner watched for in anything outbound. Chronicle showed per-category counts only, and the phrases themselves behind an explicit opt-in. Removed with the Safety page.',
  },
  {
    id: 'retired.safety-gaps',
    page: 'retired',
    title: 'Safety gaps (retired)',
    plain: () => 'A curated risk register kept outside Chronicle: each row a known hole in the egress posture, accepted ones included. Actionable rows needed work; watch rows were accepted risks waiting on a trigger. Removed with the Safety page.',
  },
  {
    id: 'retired.safety-caps',
    page: 'retired',
    title: 'Spend caps (retired)',
    plain: () => 'The egress gate refused a single spend above a per-transaction cap and cut a session off at a session cap. Chronicle only displayed them. For your own budget, the Spend tab’s monthly budget line is the surviving control.',
  },
  {
    id: 'retired.write-log',
    page: 'retired',
    title: 'The write log (retired)',
    plain: () => 'A ledger on Safety of every change Chronicle made, newest first, each with the exact diff it wrote and an Undo. It existed because changes used to go through a confirm-and-backup gate that could record them. The gate is gone and Chronicle no longer writes outside its own database, so there is nothing left for the log to record.',
  },
  {
    id: 'retired.confirm-card',
    page: 'retired',
    title: 'Confirm card (retired)',
    plain: () => 'A diff shown for approval before a change was written: propose, read the validated diff, then Confirm or Deny. It guarded edits to configuration kept outside Chronicle. Removed with those surfaces; Chronicle’s own edits (rename, delete, settings, redaction rules) apply when you click, as they always did.',
  },
  {
    id: 'retired.safety-roster',
    page: 'retired',
    title: 'Routing roster (retired)',
    plain: () => 'A hand-curated list of allowed model families, read from an external governance file, against which the Spend tab graded a window’s models as on- or off-roster. Removed: the file lived in another project’s folder, which Chronicle no longer reads.',
  },
];

/** id -> Definition. Built once; a missing id is a programming error the
 *  anti-drift test catches rather than something to fail soft at runtime. */
export const DEF_BY_ID: Map<string, Definition> = new Map(DEFINITIONS.map((d) => [d.id, d]));

export function getDefinition(id: string): Definition | undefined {
  return DEF_BY_ID.get(id);
}
