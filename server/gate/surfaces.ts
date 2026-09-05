import type { Surface } from './core.ts';
import { narrowLaunchd } from './approval.ts';

// The console's gate surface registry (CHI-323 part 2). A typed const, not a
// JSON asset: Chronicle's server is tsc-compiled (not bundled) and tsc does not
// copy a .json into dist-server/, so an on-disk surfaces.json would vanish in
// the published package. This is the whole registry.
//
// Ported from Varde MINUS its own `aggregator-config` surface (Varde's config
// file, not a Chronicle surface).
//
// CHI-329: each row declares an `approval` posture. ABSENT MEANS CONFIRM, so a
// new row that forgets to think about it gets the card. The four hub-writing
// rows stay `confirm` under CHI-378 floor class 4 (in-place edits to the gate's
// own config); `hermes-approvals` is Tier 2 on top of that. Only the two rows
// that write Chronicle's own state go auto. See CHI-395: the four hub rows are
// additionally INERT today, because the hub deleted the entry point they write
// through.
export const SURFACES: Surface[] = [
  {
    id: 'hub-spend-caps',
    title: 'Egress gate spend caps',
    description: "Per-transaction and per-session spend caps for the connected hub's egress gate, edited through the confirm-first write flow.",
    target: '${AIOS_HUB}/scripts/egress_gate/data/gate_config.json',
    schema: 'hub-gate-config',
    writeVia: 'hub-script',
    tier: 1,
    secondChannel: null,
    // Floor class 4: the gate's own config. Direction-awareness was tried and
    // rejected (rev 1) - this schema is shared with hub-egress-enabled over one
    // file, so a 'tightening' cap edit can legally carry a kill-switch flip.
    approval: 'confirm',
  },
  {
    id: 'hub-egress-enabled',
    title: 'Egress kill switch (on/off)',
    description: "Toggles the connected hub's egress gate on or off. OFF fail-closed denies all gated outward sends. Edited through the confirm-first write flow.",
    target: '${AIOS_HUB}/scripts/egress_gate/data/gate_config.json',
    schema: 'hub-gate-config',
    writeVia: 'hub-script',
    tier: 1,
    secondChannel: null,
    approval: 'confirm',
  },
  {
    id: 'hub-classification',
    title: 'Egress classification (egress gate)',
    description: "Tool and command class buckets (read | send | publish | spend) for the connected hub's egress gate. Security-critical; full-object edits only.",
    target: '${AIOS_HUB}/scripts/egress_gate/data/classification.json',
    schema: 'hub-classification',
    writeVia: 'hub-script',
    tier: 1,
    secondChannel: null,
    approval: 'confirm',
  },
  {
    id: 'hub-confidential-markers',
    title: 'Confidential markers (egress gate)',
    description: "Strong and ambiguous confidentiality-scan markers for the connected hub's egress gate. Full-object edits only.",
    target: '${AIOS_HUB}/scripts/egress_gate/data/confidential_markers.json',
    schema: 'hub-confidential-markers',
    writeVia: 'hub-script',
    tier: 1,
    secondChannel: null,
    approval: 'confirm',
  },
  {
    id: 'hermes-approvals',
    title: 'Interactive approval policy (deny globs + posture)',
    description: 'Deny globs, approval mode, and timeout for the interactive approval policy. Edited through the confirm-first write flow, with a second confirmation step.',
    target: '${HOME}/.hermes/config.yaml',
    schema: 'hermes-approvals',
    tier: 2,
    secondChannel: 'telegram',
    approval: 'confirm',
  },
  {
    id: 'launchd-jobs',
    title: 'Scheduled jobs (launchd) pause / resume',
    description: 'Pause or resume any installed launchd job. The schedule definition is never edited, so resume restores exactly the installed schedule. Applies without a card, except for jobs that carry enforcement or the approval channel.',
    target: '${HOME}/Library/LaunchAgents',
    schema: 'action:launchd',
    kind: 'action',
    tier: 1,
    secondChannel: null,
    // Reversible by construction: the plist is never edited, so resume restores
    // exactly the installed schedule. narrowLaunchd cards a pause of any job
    // whose name says it carries enforcement, reporting, or the approval
    // channel; the operator can extend that set locally.
    approval: 'auto',
    narrow: narrowLaunchd,
  },
];
