// Synthetic hub slices for demo mode (CHRONICLE_DEMO=1). Generic-fictional
// names only, never real hub data. A zero-data user (or a fresh machine) sees
// the full product against this seed; every real-state action fail-closes at
// the route layer. 1h expands this into the full demo seed; each organ adds its
// slice here as it lands.
import type { ModulesSlice } from './slices/modules.ts';
import type { SafetyNetSlice } from './slices/safetynet.ts';
import type { EgressSlice } from './slices/egress.ts';

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
