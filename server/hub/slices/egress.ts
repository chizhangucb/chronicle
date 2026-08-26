import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Egress slice (ported from Varde): the on/off state of the hub's egress gate,
 * read from its own gate_config.json. Fails SAFE: a missing/unparseable file
 * reads back enabled:true (the gate's own absent-key default) with
 * gateConfigFound:false, so the panel flags "gate config not found" rather than
 * silently claiming a healthy read.
 */
export interface EgressSlice {
  enabled: boolean;
  gateConfigFound: boolean;
}

export function collectEgress(hubRoot: string): EgressSlice {
  const gateConfigPath = join(hubRoot, 'scripts', 'egress_gate', 'data', 'gate_config.json');
  try {
    const parsed = JSON.parse(readFileSync(gateConfigPath, 'utf8')) as { enabled?: boolean };
    return { enabled: parsed.enabled !== false, gateConfigFound: true };
  } catch {
    return { enabled: true, gateConfigFound: false };
  }
}
