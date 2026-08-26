import type { Surface } from './core.ts';

// The console's gate surface registry (CHI-323 part 2). A typed const, not a
// JSON asset: Chronicle's server is tsc-compiled (not bundled) and tsc does not
// copy a .json into dist-server/, so an on-disk surfaces.json would vanish in
// the published package. This is the whole registry.
//
// Ported from Varde MINUS its own `aggregator-config` surface (Varde's config
// file, not a Chronicle surface). The `memory-scope` surface's schema shipped
// with 1b (validate.ts); the row itself lands with the scope-suggest fast-follow
// (CHI-339).
export const SURFACES: Surface[] = [
  {
    id: 'hub-spend-caps',
    title: 'Egress gate spend caps',
    description: "Per-transaction and per-session spend caps in the hub's gate_config.json. Written via the hub entry point, auto-committed agent-attributed.",
    target: '${AIOS_HUB}/scripts/egress_gate/data/gate_config.json',
    schema: 'hub-gate-config',
    writeVia: 'hub-script',
    tier: 1,
    repeatable: false,
    secondChannel: null,
  },
  {
    id: 'hub-egress-enabled',
    title: 'Egress kill switch (on/off)',
    description: 'Toggles the egress gate enabled flag in the hub gate_config.json. OFF fail-closed denies all gated outward sends. Written via the hub entry point, auto-committed.',
    target: '${AIOS_HUB}/scripts/egress_gate/data/gate_config.json',
    schema: 'hub-gate-config',
    writeVia: 'hub-script',
    tier: 1,
    repeatable: true,
    secondChannel: null,
  },
  {
    id: 'hub-classification',
    title: 'Egress classification (egress gate)',
    description: "Tool/command class buckets (read | send | publish | spend) in the hub's classification.json. Security-critical; full-object edits only.",
    target: '${AIOS_HUB}/scripts/egress_gate/data/classification.json',
    schema: 'hub-classification',
    writeVia: 'hub-script',
    tier: 1,
    repeatable: false,
    secondChannel: null,
  },
  {
    id: 'hub-confidential-markers',
    title: 'Confidential markers (egress gate)',
    description: "Strong and ambiguous confidentiality scan markers in the hub's confidential_markers.json. Full-object edits only.",
    target: '${AIOS_HUB}/scripts/egress_gate/data/confidential_markers.json',
    schema: 'hub-confidential-markers',
    writeVia: 'hub-script',
    tier: 1,
    repeatable: false,
    secondChannel: null,
  },
  {
    id: 'hermes-approvals',
    title: 'Hermes approvals (deny globs + posture)',
    description: 'The approvals block of ~/.hermes/config.yaml: deny globs, approval mode, timeout. Tier 2: confirming needs the code from the Telegram card.',
    target: '${HOME}/.hermes/config.yaml',
    schema: 'hermes-approvals',
    tier: 2,
    repeatable: false,
    secondChannel: 'telegram',
  },
  {
    id: 'memory-scope',
    title: 'Memory scope (living / historical / excluded)',
    description: "Which hub files count as knowledge, and in what tier, in Chronicle's memory-scope config. Edits apply through a confirm card and take effect on the next memory read.",
    target: '${HOME}/.chronicle/memory-scope.json',
    schema: 'memory-scope',
    tier: 1,
    repeatable: true,
    secondChannel: null,
  },
  {
    id: 'launchd-jobs',
    title: 'Scheduled jobs (launchd) pause / resume',
    description: 'Pause (launchctl bootout) or resume (launchctl bootstrap) any installed launchd job, behind the confirm card. The plist is never edited, so resume restores exactly the installed schedule.',
    target: '${HOME}/Library/LaunchAgents',
    schema: 'action:launchd',
    kind: 'action',
    tier: 1,
    repeatable: true,
    secondChannel: null,
  },
];
