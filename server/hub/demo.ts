// Synthetic hub slices for demo mode (CHRONICLE_DEMO=1). Generic-fictional
// names only, never real hub data. A zero-data user (or a fresh machine) sees
// the full product against this seed; every real-state action fail-closes at
// the route layer. 1h expands this into the full demo seed; each organ adds its
// slice here as it lands.
import type { SafetyNetSlice } from './slices/safetynet.ts';
import type { EgressSlice } from './slices/egress.ts';
import type { GatingPolicySlice } from './slices/gatingpolicy.ts';

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

