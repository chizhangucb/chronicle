// Synthetic hub slices for demo mode (CHRONICLE_DEMO=1). Generic-fictional
// names only, never real hub data. A zero-data user (or a fresh machine) sees
// the full product against this seed; every real-state action fail-closes at
// the route layer. 1h expands this into the full demo seed; each organ adds its
// slice here as it lands.
import type { ModulesSlice } from './slices/modules.ts';
import type { SafetyNetSlice } from './slices/safetynet.ts';
import type { EgressSlice } from './slices/egress.ts';
import type { GatingPolicySlice } from './slices/gatingpolicy.ts';

export const DEMO_MODULES: ModulesSlice = {
  found: true,
  rows: [
    {
      name: 'atlas',
      tier: 'core',
      purpose: 'Request router + typed read seam for the workspace.',
      prdHome: 'projects/atlas',
      project: 'atlas',
      contract: {
        status: 'full',
        raw: 'projects/atlas/product-contract.md',
        pendingTicket: null,
        path: 'projects/atlas/product-contract.md',
        available: true,
        markdown: [
          '# Atlas module contract',
          '',
          'What it is: the workspace request router. Owns route resolution and the',
          'typed read seam every surface composes against.',
          '',
          '## Surfaces',
          '- `/atlas/status` health + mode',
          '- `/atlas/routes` resolved route table',
          '',
          '## Invariants',
          '- Read-only against the store; all writes go through the gate.',
          '- No outbound network calls.',
        ].join('\n'),
      },
    },
    {
      name: 'ledger',
      tier: 'core',
      purpose: 'Append-only activity log with per-day rollups.',
      prdHome: 'projects/ledger',
      project: 'ledger',
      contract: {
        status: 'grandfathered',
        raw: 'projects/ledger/product-contract.md',
        pendingTicket: null,
        path: 'projects/ledger/product-contract.md',
        available: true,
        markdown: [
          '# Ledger module contract',
          '',
          'What it is: the append-only activity log. Every action lands one row;',
          'rollups are derived, never authoritative.',
          '',
          '## Invariants',
          '- Append-only. Rows are never mutated in place.',
        ].join('\n'),
      },
    },
    {
      name: 'beacon',
      tier: 'satellite',
      purpose: 'Scheduled health probes + heartbeat digest.',
      prdHome: 'projects/beacon',
      project: 'beacon',
      contract: {
        status: 'pending',
        raw: '(pending DEMO-204)',
        pendingTicket: 'DEMO-204',
        path: null,
        available: false,
        markdown: null,
      },
    },
  ],
};

export const DEMO_SAFETYNET: SafetyNetSlice = {
  found: true,
  gateConfig: { enabled: true, spend_per_tx_cap: 5, spend_per_session_cap: 50, unclassified_deny_daily_cap: 25 },
  classification: {
    tools: [
      { name: 'web.fetch', class: 'read' },
      { name: 'search.query', class: 'read' },
      { name: 'mail.send', class: 'send' },
      { name: 'post.publish', class: 'publish' },
      { name: 'pay.charge', class: 'spend' },
    ],
  },
  markers: { categories: [{ category: 'strong', count: 6 }, { category: 'ambiguous', count: 4 }] },
  proxyServers: { names: ['router-a', 'router-b'] },
};

export const DEMO_EGRESS: EgressSlice = { enabled: true, gateConfigFound: true };

export const DEMO_GATINGPOLICY: GatingPolicySlice = {
  found: true,
  pushPins: [
    {
      repo: 'atlas-hub', visibility: 'private', remoteUrls: ['https://github.com/demo-owner/atlas-hub.git'],
      branches: ['main'], anyBranch: true, confidentialOk: true, featurePushOk: false,
      prProtectedBranches: [], leakScrub: false, scrubWhitelistCount: 0,
    },
    {
      repo: 'beacon', visibility: 'public', remoteUrls: ['https://github.com/demo-owner/beacon.git'],
      branches: [], anyBranch: false, confidentialOk: false, featurePushOk: true,
      prProtectedBranches: ['main'], leakScrub: true, scrubWhitelistCount: 3,
    },
  ],
  pushPinDefaults: {
    ownerUrlPattern: '^https://github\\.com/demo-owner/[^/]+(\\.git)?$',
    visibility: 'public', branches: [], featurePushOk: true,
    prProtectedBranches: ['main', 'master'], leakScrub: true, scrubWhitelistCount: 3,
  },
};

import type { JobsSlice } from './slices/jobs.ts';

export const DEMO_JOBS: JobsSlice = {
  scannedAt: '2026-08-26T09:05:00.000Z',
  sources: { launchd: 2, cron: 1, registry: 1, 'repo-template': 1 },
  jobs: [
    {
      id: 'com.chronicle.briefing', name: 'com.chronicle.briefing', source: 'launchd',
      schedule: 'daily 09:00', scheduleKind: 'calendar', nextRun: null, lastRun: '2h ago', lastRunAt: null,
      status: 'success', lastExit: 0, runner: 'node', model: null, agent: 'claude', project: 'chronicle',
      projectPath: null, command: 'node scripts/run-briefing.ts', logPath: 'data/demo-logs/briefing.log',
      description: 'Daily briefing run',
    },
    {
      id: 'com.demo.weekly-report', name: 'com.demo.weekly-report', source: 'launchd',
      schedule: 'Mon 08:00', scheduleKind: 'calendar', nextRun: null, lastRun: '3d ago', lastRunAt: null,
      status: 'paused', lastExit: null, runner: 'node', model: null, agent: null, project: 'demo',
      projectPath: null, command: 'node weekly.mjs', logPath: null,
    },
    {
      id: 'cron:backup.sh', name: 'cron: backup.sh', source: 'cron',
      schedule: '0 3 * * *', scheduleKind: 'calendar', nextRun: null, lastRun: null, lastRunAt: null,
      status: 'pending', lastExit: null, runner: 'backup.sh', model: null, agent: null, project: null,
      projectPath: null, command: '/usr/local/bin/backup.sh', logPath: null,
    },
    {
      id: 'registry:health-sweep', name: 'health-sweep', source: 'registry',
      schedule: 'every 6h', scheduleKind: 'prose', nextRun: null, lastRun: '9h ago', lastRunAt: null,
      status: 'stale', lastExit: null, runner: 'hub-registry', model: null, agent: null, project: null,
      projectPath: null, command: '', logPath: null, description: 'Probe hub health + heartbeat digest',
      meta: 'threshold 6h',
    },
    {
      id: 'com.chronicle.example-template', name: 'com.chronicle.example-template', source: 'repo-template',
      schedule: 'not scheduled', scheduleKind: 'manual', nextRun: null, lastRun: null, lastRunAt: null,
      status: 'not-installed', lastExit: null, runner: null, model: null, agent: null, project: 'chronicle',
      projectPath: null, command: '', logPath: null, meta: 'ships with this repo, not installed',
    },
  ],
};

import type { RecordsSlice } from './slices/records.ts';

// Synthetic session-ledger rows (generic-fictional; never real hub data). The
// /records phase-2 UI renders the sessions type from `ledger.rows`; decisions is
// a future switcher stub, seeded thin. Stamps sort newest-first.
// Full UUID-style ids (matching a real hub session ledger, where `session` is
// the client's own session uuid) — the UI renders the id whole, never truncated.
const DEMO_LEDGER_ROWS = [
  { date: '2026-08-26 0930', sessionId: 'a1b2c3d4-9f8e-4a2b-b7c1-3d5e6f70a1b2', focus: 'Wire the demo records surface end to end', repo: 'chronicle' },
  { date: '2026-08-25 1610', sessionId: 'e5f6a7b8-2c1d-4e3f-9a8b-7c6d5e4f3a2b', focus: 'Consolidate spend views into the analytics hub', repo: 'chronicle' },
  { date: '2026-08-25 1105', sessionId: 'c9d0e1f2-6b5a-4c3d-8e7f-1a2b3c4d5e6f', focus: 'Onboarding sweep + registry hygiene', repo: 'hub' },
  { date: '2026-08-24 1440', sessionId: 'b3c4d5e6-7a89-4b0c-9d1e-2f3a4b5c6d7e', focus: 'Budget meter + gated editor spike', repo: 'chronicle' },
  { date: '2026-08-24 0905', sessionId: 'f7a8b9c0-1d2e-4f3a-8b9c-0d1e2f3a4b5c', focus: 'Nightly briefing cadence tuning', repo: 'hub' },
];
export const DEMO_RECORDS: RecordsSlice = {
  found: true,
  decisions: { total: 2, recent: [
    { date: '2026-08-25', title: 'Merge spend/sessions into the hub, five tabs' },
    { date: '2026-08-24', title: 'Anomaly tile replaces the burn tile' },
  ] },
  ledger: { total: DEMO_LEDGER_ROWS.length, recent: DEMO_LEDGER_ROWS, rows: DEMO_LEDGER_ROWS },
};

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from './paths.ts';
import type { DashGraphEntry } from './slices/codegraph.ts';

export function demoCodegraphs(): DashGraphEntry[] {
  try {
    return (JSON.parse(readFileSync(join(packageRoot(), 'data', 'codegraphs.demo.json'), 'utf8')).graphs ?? []) as DashGraphEntry[];
  } catch {
    return [];
  }
}

