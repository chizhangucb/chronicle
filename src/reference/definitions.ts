// The definitions registry (CHI-325 3b, decision D3).
//
// ONE source for every metric definition in Chronicle. Both the small "ⓘ" tips
// scattered across the surfaces AND the /reference page read from here, so the
// page cannot drift from the console. Before this existed, every InfoTip
// carried its own inline string and a reference page would have been a second,
// silently diverging copy of them.
//
// i18n (D12): `plain`/`good`/`tech` return ENGLISH SOURCE STRINGS. Callers pass
// them through the existing `t()` (src/i18n.ts is an English-keyed dictionary
// with English fallback), so tips behave byte-identically to before the
// migration and /reference translates exactly as far as the dictionary reaches.
// No new key namespace.
//
// `vars` exists for the handful of tips that quote a live number (how many
// automation runs the manifest holds, say). On /reference there is no call
// site, so `vars` is absent and the definition must still read correctly: write
// the fallback wording first, then the interpolation.
//
// The `retired` page is load-bearing, not a curiosity. The Chronicle/Varde
// merge (CHI-322) deliberately dropped some surfaces; the decision was that the
// VOCABULARY survives even where the page did not, so someone who remembers a
// term can still find out what it meant.

export type DefPage =
  | 'overview' | 'spend' | 'sessions' | 'explore' | 'content'
  | 'projects' | 'session'
  | 'briefing' | 'memory' | 'safety' | 'jobs' | 'records' | 'modules'
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
  'briefing', 'memory', 'safety', 'jobs', 'records', 'modules',
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
  briefing: 'Briefing',
  memory: 'Memory',
  safety: 'Safety',
  jobs: 'Jobs',
  records: 'Records',
  modules: 'Modules',
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
    plain: () => 'Priced locally from billed token counts, never billed data; sessions that started before the window but ran into it are pro-rated by their in-window token share. Total includes automation spend, broken out below. Toggle List price vs Billed in the topbar.',
    tech: () => 'session_model_cost, priced client-side from src/models.ts',
  },
  {
    id: 'overview.sessions',
    page: 'overview',
    title: 'Sessions',
    plain: () => 'Interactive sessions only. Headless automation runs (weekly/nightly/session-close/spend-advice) are counted separately as automation, not here. A manifest session whose transcript is also imported is counted once, as automation.',
    tech: () => '~/.aios/machine_sessions.jsonl supplies the automation side',
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
    id: 'overview.status-band',
    page: 'overview',
    title: 'Status band',
    plain: () => 'A second read of the same five domains the ops nav covers: the trend, the explicit baseline number, and the state word. It never raises an alarm of its own. Its accent is only ever an echo of an open needs-you briefing card above it, so exactly one place on this page can tell you something new.',
  },
  {
    id: 'overview.provenance',
    page: 'overview',
    title: 'Sources strip',
    plain: () => 'Where the numbers above came from: how many sessions each tool contributed, whether a hub is connected, when the last sync landed, and which cost basis is showing. The topbar sync pill says WHEN data last landed; this says WHAT is behind the figures.',
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
    tech: () => '~/.chronicle/config.json monthlyBudget, server-side since CHI-366 so the briefing runner reads the same number',
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
    id: 'spend.proxy-lane',
    page: 'spend',
    title: 'Proxy lane (billed)',
    plain: () => 'The LiteLLM proxy spend log is the authoritative billed record for proxy-routed models, but it carries only model and time, no session or project. It is shown as its own labeled row and never smeared across sessions.',
    tech: () => '~/.aios/litellm/spend.jsonl via server/laneC.ts',
  },
  {
    id: 'spend.plan-windows',
    page: 'spend',
    title: 'Plan windows',
    plain: () => 'Your subscription quota windows: Claude 5h / 7d / top-tier-7d and Codex 7d. The Claude read is the one outbound call in Chronicle (your own quota, from api.anthropic.com, using Claude Code’s own token); it is on by default and switched off in Settings. Codex windows are read locally.',
  },

  // ---- Insights / Sessions ----
  {
    id: 'sessions.human-all',
    page: 'sessions',
    title: 'Human vs all',
    plain: (c) => `Human shows only interactive sessions (matching the KPI Sessions count). All adds the headless automation jobs from ~/.aios/machine_sessions.jsonl${c.vars?.automationCount != null ? ` (currently ${c.vars.automationCount} automation runs)` : ''}. Automation-by-job below is always automation, unaffected by this toggle.`,
  },
  {
    id: 'sessions.automation-by-job',
    page: 'sessions',
    title: 'Automation by job',
    plain: () => 'Always automation, unaffected by the human/all toggle. Sourced from the ~/.aios/machine_sessions.jsonl manifest (weekly / nightly / session-close / spend-advice jobs).',
  },
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

  // ---- Ops surfaces (ported from Varde, CHI-323/324) ----
  {
    id: 'briefing.needs-you',
    page: 'briefing',
    title: 'Needs you vs FYI',
    plain: () => 'Needs-you cards are action or decision items and carry the attention accent. FYI cards are worth knowing; nothing is owed.',
  },
  {
    id: 'briefing.run',
    page: 'briefing',
    title: 'Run briefing',
    plain: () => 'Runs a real headless model session that reads the projection and writes the day’s cards. It costs a model call, and the confirm card says so before it fires.',
  },
  {
    id: 'briefing.two-file-split',
    page: 'briefing',
    title: 'Why the run and your actions are separate files',
    plain: () => 'The briefing run writes briefing.json; acting on a card writes briefing-state.json. Neither ever writes the other’s file, so a run in progress can never clobber a decision you just made.',
  },
  {
    id: 'memory.living-vs-records',
    page: 'memory',
    title: 'Living notes vs records',
    plain: () => 'Living notes (wiki pages, governance, skills, context, references, registry files) are maintained-in-place knowledge and are what gets measured. Records (decisions, sessions, brainstorms, reports, archives, sources) are dated history: evidence, never rot.',
  },
  {
    id: 'memory.freshness',
    page: 'memory',
    title: 'Freshness and stale',
    plain: (c) => `Age is days since a living note’s last edit; past ${c.vars?.thresholdDays ?? 30} days it counts as stale. Records never rot, so they are not in this count.`,
  },
  {
    id: 'memory.orphan',
    page: 'memory',
    title: 'Orphans and unlinked',
    plain: () => 'An orphan is a living note with zero links in or out AND zero touches in the selected window: unreachable and unused. Unlinked alone is a neutral count; a note your sessions touch daily is not orphaned.',
  },
  {
    id: 'memory.communities',
    page: 'memory',
    title: 'Communities',
    plain: () => 'Notes are colored by a deterministic community assignment computed from the link graph, so the same corpus always produces the same colors. The grouping is structural, not semantic: it reflects what links to what, not what the notes are about.',
  },
  {
    id: 'memory.confidential-pruning',
    page: 'memory',
    title: 'What the graph never shows',
    plain: () => 'Only titles and paths reach the browser, and confidential trees are pruned server-side before the graph is built. Note bodies are never sent.',
  },
  {
    id: 'safety.gate',
    page: 'safety',
    title: 'The egress gate',
    plain: () => 'The egress gate sits in front of anything your agents send, publish or spend: every gated call passes an intent check and a confidentiality scan before it leaves this machine. OFF is fail-closed: every gated outward send is denied, not waved through.',
  },
  {
    id: 'safety.markers',
    page: 'safety',
    title: 'Confidentiality markers',
    plain: () => 'Phrases the gate’s confidentiality scanner watches for in anything outbound. Chronicle shows only per-category COUNTS; the phrases themselves are served only when this instance explicitly opts in.',
  },
  {
    id: 'safety.gaps',
    page: 'safety',
    title: 'Safety gaps',
    plain: () => 'A curated risk register: each row is a known hole in the posture, stated plainly, accepted ones included. A gap stands until the closing edit is made; actionable rows need work, watch rows are accepted risks waiting on a trigger.',
  },
  {
    id: 'safety.caps',
    page: 'safety',
    title: 'Spend caps',
    plain: () => 'The gate refuses a single spend above the per-transaction cap and cuts a session off at the session cap. An explicit null means that axis is unconstrained.',
  },
  {
    id: 'safety.roster',
    page: 'safety',
    title: 'Routing roster',
    plain: () => 'The trust policy from your hub’s governance/routing.md: which external models are allowed, at what trust level (no-train means the destination must not train on your data), through which billing lane. Hand-curated, so a model only appears once it has been reviewed.',
  },
  {
    id: 'jobs.states',
    page: 'jobs',
    title: 'Job states',
    plain: () => 'running and success are healthy; due means the scheduled time passed without a recorded run. failed and stale need a look, paused means unloaded until you resume it, and not-installed means this repo ships the job but this machine does not run it.',
  },
  {
    id: 'jobs.sources',
    page: 'jobs',
    title: 'Where jobs come from',
    plain: () => 'launchd is how macOS schedules background work; crontab is the classic Unix scheduler (0 is normal on a Mac). Hub registry is what your automations registry declares should exist; repo templates are jobs a repo ships but that are not installed here.',
  },
  {
    id: 'jobs.pause',
    page: 'jobs',
    title: 'Pause and resume',
    plain: () => 'Pause unloads a job from launchd so it stops running; resume loads it again with exactly the installed schedule. Both go through the confirm card and are audited; the plist file is never edited.',
  },
  {
    id: 'records.append-only',
    page: 'records',
    title: 'Append-only records',
    plain: () => 'The hub’s records are append-only logs: rows are added, never edited in place. Chronicle reads index fields only (date, id, repo, focus) and never the body of a decision.',
  },
  {
    id: 'modules.contract-status',
    page: 'modules',
    title: 'Contract status',
    plain: () => 'Whether the module ships a product-contract.md and whether Chronicle could read it. This is a presence check on the file, not a judgment about the contract’s content.',
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

  // ---- Retired: dropped in the Chronicle/Varde merge (CHI-322 Q6/Q7) ----
  // The surfaces are gone; the vocabulary survives, so a term you remember can
  // still be looked up. Each says plainly what replaced it.
  {
    id: 'retired.pinned-panels',
    page: 'retired',
    title: 'Pinned panels (retired)',
    plain: () => 'Varde could promote a committed read-only SQL query over the contract_* views into a dashboard panel. Exactly one panel ever existed, "MCP tool calls by server", and that content is now a native feature on the Spend tab. The promote-to-panel mechanism itself was dropped in the merge; the Explore tab covers ad-hoc querying.',
  },
  {
    id: 'retired.peek-drill',
    page: 'retired',
    title: 'Peek drill (retired)',
    plain: () => 'Varde’s quick preview of a session from a spend row. Dropped in the merge because Chronicle’s session Overview is a richer version of the same idea; a row click goes straight there.',
  },
  {
    id: 'retired.burn-tile',
    page: 'retired',
    title: 'Burn tile (retired)',
    plain: () => 'Chronicle’s original client-side spend-versus-baseline tile. Replaced in CHI-324 by the Anomaly tile, which keeps the same anatomy and window rules but adds dimension movers, flagged days, and the proxy-lane note.',
  },
  {
    id: 'retired.nisse-upsell',
    page: 'retired',
    title: 'Nisse coupling',
    plain: () => 'Not retired: the ops surfaces (Briefing, Memory, Safety, Jobs, Records, Modules) light up when a nisse-format hub is present and are hidden when it is absent. This entry exists because the vocabulary is easy to meet before the panels appear.',
  },
];

/** id -> Definition. Built once; a missing id is a programming error the
 *  anti-drift test catches rather than something to fail soft at runtime. */
export const DEF_BY_ID: Map<string, Definition> = new Map(DEFINITIONS.map((d) => [d.id, d]));

export function getDefinition(id: string): Definition | undefined {
  return DEF_BY_ID.get(id);
}
