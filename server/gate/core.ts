import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { validate, applyChange } from './validate.ts';

/**
 * Gate core: the confirm-first write channel, ported from Varde (CHI-323 part 2).
 * Every write follows propose -> validate -> card -> confirm -> backup ->
 * write -> verify -> audit. No retries; every failure carries a reason and a
 * fix. The express routes (routes.ts) are transport only; all decisions live
 * here so tests can drive the whole flow without a server.
 *
 * Two Chronicle changes from Varde's core (port-fidelity fixes, CHI-323):
 *   (a) resolveTarget drops Varde's env/home hub fallback (the exact probe D3
 *       removed). hubRoot is fed from the adapter's resolved root; when the hub
 *       is absent, ${AIOS_HUB} stays unresolved so the surface renders
 *       unavailable, matching the read path.
 *   (d5) audit goes to an injected AuditStore (a SQLite gate_audit table in
 *        production), not a JSON file. Backups stay files.
 */

export interface Surface {
  id: string;
  title: string;
  description?: string;
  /** Env-resolved template: ${HOME}, ${AIOS_HUB}. */
  target: string;
  schema: string;
  tier: 1 | 2;
  repeatable: boolean;
  secondChannel: string | null;
  /** "file" (default) writes the target; "action" runs a registered ActionImpl
   * (e.g. launchd pause/resume). Same card + audit either way. */
  kind?: 'file' | 'action';
  /** "allow": the UI click is the intent; apply() runs the whole validate ->
   * backup -> write -> verify pipeline in one call with an "allowed" audit row,
   * no confirm card. Default "confirm". */
  mode?: 'confirm' | 'allow';
  /** "hub-script": satellite code never opens the target for write; the
   * confirmed content is handed to the hub entry point
   * (scripts/egress_gate/apply_edit.py), which validates again, backs up,
   * writes, and auto-commits agent-attributed. */
  writeVia?: 'direct' | 'hub-script';
}

/** Runner for hub-script surfaces; injected so tests can fake it. */
export type HubApply = (payload: {
  surface: string;
  file: string;
  content: string;
  reason: string;
}) => { ok: boolean; error?: string; fix?: string; backup?: string; commit?: string; applied?: string };

/** A gated action surface: describe() renders the card diff without acting,
 * execute() performs the action after the confirm and returns the verified
 * post-state shown on the card. Both throw GateError on invalid input. */
export interface ActionImpl {
  describe(change: unknown): DiffEntry[];
  execute(change: unknown): string;
}

export interface SurfaceStatus extends Surface {
  resolvedTarget: string | null;
  available: boolean;
  /** Why the surface is disabled, when it is (graceful degradation). */
  unavailableReason?: string;
}

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

export interface Proposal {
  id: string;
  surfaceId: string;
  reason: string;
  before: string | null;
  after: string;
  diff: DiffEntry[];
  /** Action surfaces carry the raw change payload for execute(). */
  change?: unknown;
  /** Tier 2: one-time code delivered over the second channel. Never serialized
   * to the browser; the transport strips it. */
  secondFactor?: string;
  /** Tier 2 marker for the card UI: confirm needs the code. */
  requiresCode?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface AuditRow {
  ts: string;
  /** "allowed" rows come from allow-class sidecar endpoints (no card). */
  event: 'proposed' | 'confirmed' | 'denied' | 'expired' | 'failed' | 'allowed';
  surface: string;
  proposalId: string;
  actor: string;
  reason: string;
  diff: DiffEntry[];
  backup?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

/** Persistence seam for the audit trail (D5). Production is a SQLite
 * gate_audit table (audit-store.ts); tests pass an in-memory array store. */
export interface AuditStore {
  append(row: AuditRow): void;
  read(limit: number): AuditRow[];
}

/** Proposals die after this long without a confirm. */
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

export interface GateOptions {
  repoRoot: string;
  audit: AuditStore;
  backupDir: string;
  surfaces: Surface[];
  /** Registered ActionImpls keyed by surface id (kind: "action" surfaces). */
  actions?: Record<string, ActionImpl>;
  /** Hub-script write runner (writeVia: "hub-script" surfaces). */
  hubApply?: HubApply;
  /** Second-channel sender for Tier 2 confirms. A failed send is a loud propose
   * error, never a silent no-op. */
  secondChannelSend?: (message: string) => { ok: boolean; reason?: string };
  hubRoot?: string;
  now?: () => number;
}

export class Gate {
  readonly token = randomBytes(32).toString('hex');
  private proposals = new Map<string, Proposal>();
  private opts: GateOptions;
  private applying = false;

  constructor(opts: GateOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  resolveTarget(surface: Surface): string | null {
    // Port fix (a): NO env/home hub fallback. hubRoot comes from the adapter;
    // absent -> ${AIOS_HUB} stays unresolved -> surface unavailable, exactly
    // like the read path degrades.
    let out = surface.target.replace('${HOME}', homedir());
    if (this.opts.hubRoot) out = out.replace('${AIOS_HUB}', this.opts.hubRoot);
    if (this.opts.repoRoot) out = out.replace('${REPO}', this.opts.repoRoot);
    return out.includes('${') ? null : out;
  }

  listSurfaces(): SurfaceStatus[] {
    return this.opts.surfaces.map((s) => {
      const resolvedTarget = this.resolveTarget(s);
      if (!resolvedTarget) {
        return { ...s, resolvedTarget, available: false, unavailableReason: 'target path has an unresolved variable (no hub configured)' };
      }
      if (s.tier === 2 && !s.secondChannel) {
        return { ...s, resolvedTarget, available: false, unavailableReason: 'Tier 2 surface with no second channel configured' };
      }
      if (s.tier === 2 && !this.opts.secondChannelSend) {
        return { ...s, resolvedTarget, available: false, unavailableReason: 'second channel (hermes send) not configured on this machine' };
      }
      if (s.kind === 'action' && !this.opts.actions?.[s.id]) {
        return { ...s, resolvedTarget, available: false, unavailableReason: 'no action implementation registered on this platform' };
      }
      if (s.writeVia === 'hub-script') {
        if (!this.opts.hubApply) {
          return { ...s, resolvedTarget, available: false, unavailableReason: 'hub entry point not configured (no hub checkout)' };
        }
        if (!existsSync(resolvedTarget)) {
          return { ...s, resolvedTarget, available: false, unavailableReason: `target ${resolvedTarget} does not exist (no hub checkout here)` };
        }
      }
      return { ...s, resolvedTarget, available: true };
    });
  }

  /** Current parsed content of a surface's target (null when absent). */
  readSurface(surfaceId: string): { surface: SurfaceStatus; text: string | null } {
    const surface = this.listSurfaces().find((s) => s.id === surfaceId);
    if (!surface) throw new GateError(404, `unknown surface "${surfaceId}"`, 'check server/gate/surfaces.ts');
    if (!surface.available || !surface.resolvedTarget) {
      throw new GateError(409, `surface "${surfaceId}" is disabled: ${surface.unavailableReason}`, 'fix the surface registry entry');
    }
    if (surface.kind === 'action') return { surface, text: null };
    const text = existsSync(surface.resolvedTarget) ? readFileSync(surface.resolvedTarget, 'utf-8') : null;
    return { surface, text };
  }

  /** Step 1 of the flow. Validates the RESULTING file; invalid input is a loud
   * error and no card is ever shown (nothing is stored). */
  propose(surfaceId: string, change: unknown, reason: string): Proposal {
    const { surface, text } = this.readSurface(surfaceId);
    if (surface.kind === 'action') {
      const impl = this.opts.actions![surface.id];
      const diff = impl.describe(change);
      if (diff.length === 0) throw new GateError(400, 'action is a no-op', 'nothing to confirm');
      const createdAtA = this.now();
      const proposal: Proposal = {
        id: randomBytes(12).toString('hex'),
        surfaceId,
        reason: String(reason ?? '').trim() || '(no reason given)',
        before: null,
        after: '',
        diff,
        change,
        createdAt: new Date(createdAtA).toISOString(),
        expiresAt: new Date(createdAtA + PROPOSAL_TTL_MS).toISOString(),
      };
      this.finalizeTier2(surface, proposal);
      this.proposals.set(proposal.id, proposal);
      this.audit({ event: 'proposed', proposal });
      return proposal;
    }
    const applied = applyChange(surface.schema, text, change);
    const verdict = validate(surface.schema, applied.after);
    if (!verdict.ok) {
      throw new GateError(
        400,
        `invalid change for "${surfaceId}": ${verdict.errors.join('; ')}`,
        'fix the listed fields and propose again',
      );
    }
    if (applied.diff.length === 0) {
      throw new GateError(400, 'change is a no-op: resulting file is identical', 'nothing to confirm');
    }
    const createdAt = this.now();
    const proposal: Proposal = {
      id: randomBytes(12).toString('hex'),
      surfaceId,
      reason: String(reason ?? '').trim() || '(no reason given)',
      before: text,
      after: applied.after,
      diff: applied.diff,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + PROPOSAL_TTL_MS).toISOString(),
    };
    this.finalizeTier2(surface, proposal);
    this.proposals.set(proposal.id, proposal);
    this.audit({ event: 'proposed', proposal });
    return proposal;
  }

  /** Tier 2: the browser shows pending; the yes needs the one-time code that
   * only exists on the second-channel card. A failed send aborts the propose
   * loudly; there is never a card without its second channel. */
  private finalizeTier2(surface: SurfaceStatus, proposal: Proposal): void {
    if (surface.tier !== 2) return;
    const send = this.opts.secondChannelSend;
    if (!send) throw new GateError(409, 'second channel (hermes send) not configured', 'install hermes and configure the telegram channel');
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const lines = proposal.diff.slice(0, 12).map((d) => `  ${d.path}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
    const message = [
      `Gate confirm needed (Tier 2): ${surface.title}`,
      `Reason: ${proposal.reason}`,
      'Diff:',
      ...lines,
      proposal.diff.length > 12 ? `  (+${proposal.diff.length - 12} more)` : '',
      `Code: ${code}`,
      `Enter it on the dashboard card. Expires ${proposal.expiresAt} (15 min). Deny by ignoring.`,
    ].filter(Boolean).join('\n');
    const sent = send(message);
    if (!sent.ok) {
      throw new GateError(502, `Telegram confirm could not be sent: ${sent.reason ?? 'unknown'}`, 'fix the hermes telegram channel, then propose again');
    }
    proposal.secondFactor = code;
    proposal.requiresCode = true;
  }

  /** One-shot write for allow-mode surfaces (no card): same validate -> backup
   * -> write -> verify pipeline as propose+confirm, audited as "allowed" with
   * the diff. Refuses confirm-mode surfaces. */
  apply(surfaceId: string, change: unknown, reason: string, actor = 'operator'): { applied: string; backup: string | null; target: string; diff: DiffEntry[] } {
    const surface = this.listSurfaces().find((s) => s.id === surfaceId);
    if (!surface) throw new GateError(404, `unknown surface "${surfaceId}"`, 'check server/gate/surfaces.ts');
    if (surface.mode !== 'allow') {
      throw new GateError(403, `surface "${surfaceId}" requires the confirm card`, 'use propose + confirm');
    }
    this.applying = true; // one "allowed" row instead of proposed+confirmed
    let proposal: Proposal;
    try {
      proposal = this.propose(surfaceId, change, reason);
      const result = this.confirm(proposal.id, actor);
      this.applying = false;
      this.opts.audit.append({
        ts: new Date(this.now()).toISOString(),
        event: 'allowed',
        surface: surfaceId,
        proposalId: proposal.id,
        actor,
        reason: proposal.reason,
        diff: proposal.diff,
        ...(result.backup ? { backup: result.backup } : {}),
      });
      return { ...result, diff: proposal.diff };
    } catch (err) {
      this.applying = false;
      throw err;
    }
  }

  private take(proposalId: string): Proposal {
    const p = this.proposals.get(proposalId);
    if (!p) throw new GateError(404, 'unknown or already-settled proposal', 'propose the edit again');
    if (Date.parse(p.expiresAt) <= this.now()) {
      this.proposals.delete(proposalId);
      this.audit({ event: 'expired', proposal: p });
      throw new GateError(410, 'proposal expired (15 minute TTL)', 'propose the edit again');
    }
    return p;
  }

  /** Expire-sweep: called by transports so pending cards die on time even
   * without a confirm attempt. Returns the ids it expired. */
  sweepExpired(): string[] {
    const dead: string[] = [];
    for (const [id, p] of this.proposals) {
      if (Date.parse(p.expiresAt) <= this.now()) {
        this.proposals.delete(id);
        this.audit({ event: 'expired', proposal: p });
        dead.push(id);
      }
    }
    return dead;
  }

  deny(proposalId: string, actor = 'operator'): void {
    const p = this.take(proposalId);
    this.proposals.delete(proposalId);
    this.audit({ event: 'denied', proposal: p, actor });
  }

  /** Steps confirm -> backup -> write -> verify -> audit. A failure at any
   * point audits "failed" and throws; the write is never retried. */
  confirm(proposalId: string, actor = 'operator', code?: string): { applied: string; backup: string | null; target: string } {
    const p = this.take(proposalId);
    if (p.secondFactor && code !== p.secondFactor) {
      // the proposal survives a wrong code (retyping is not a write retry);
      // only the TTL or an explicit deny kills it
      throw new GateError(403, 'second-channel code missing or wrong', 'enter the code from the Telegram card');
    }
    const { surface, text } = this.readSurface(p.surfaceId);
    if (surface.kind === 'action') {
      this.proposals.delete(proposalId);
      try {
        const applied = this.opts.actions![surface.id].execute(p.change);
        this.audit({ event: 'confirmed', proposal: p, actor });
        return { applied, backup: null, target: surface.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.audit({ event: 'failed', proposal: p, actor, error: msg });
        if (err instanceof GateError) throw err;
        throw new GateError(500, `action failed: ${msg}`, 'check the dev-server log; the action was not retried');
      }
    }
    const target = surface.resolvedTarget!;
    if (text !== p.before) {
      this.proposals.delete(proposalId);
      this.audit({ event: 'failed', proposal: p, actor, error: 'target changed since the card was shown' });
      throw new GateError(409, 'target file changed since the proposal was made', 're-propose against the current file');
    }
    if (surface.writeVia === 'hub-script') {
      this.proposals.delete(proposalId);
      try {
        const result = this.opts.hubApply!({
          surface: surface.id,
          file: target.split('/').pop()!,
          content: p.after,
          reason: p.reason,
        });
        if (!result.ok) {
          throw new GateError(500, result.error ?? 'hub apply_edit failed', result.fix ?? 'see the hub script output');
        }
        // post-write verify: the hub file must now hold exactly the card's content
        const landed = readFileSync(target, 'utf-8');
        if (landed !== p.after) {
          throw new GateError(500, 'post-write verify failed: hub file does not match the confirmed content', result.backup ? `restore from backup ${result.backup}` : 'inspect the hub file');
        }
        this.audit({ event: 'confirmed', proposal: p, actor, backup: result.backup });
        return { applied: landed, backup: result.backup ?? null, target };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.audit({ event: 'failed', proposal: p, actor, error: msg });
        if (err instanceof GateError) throw err;
        throw new GateError(500, `hub write failed: ${msg}`, 'the write was not retried; re-propose after fixing the cause');
      }
    }
    let backup: string | null = null;
    try {
      if (text !== null) {
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        mkdirSync(this.opts.backupDir, { recursive: true });
        backup = join(this.opts.backupDir, `${surface.id}.${stamp}.bak`);
        copyFileSync(target, backup);
      }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.gate-tmp`;
      writeFileSync(tmp, p.after);
      renameSync(tmp, target);
      // post-write verify: re-read and re-validate what actually landed
      const landed = readFileSync(target, 'utf-8');
      const verdict = validate(surface.schema, landed);
      if (landed !== p.after || !verdict.ok) {
        throw new Error(`post-write verify failed: ${verdict.ok ? 'content mismatch' : verdict.errors.join('; ')}`);
      }
      this.proposals.delete(proposalId);
      this.audit({ event: 'confirmed', proposal: p, actor, backup: backup ?? undefined });
      return { applied: landed, backup, target };
    } catch (err) {
      this.proposals.delete(proposalId);
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: 'failed', proposal: p, actor, backup: backup ?? undefined, error: msg });
      throw new GateError(500, `write failed: ${msg}`, backup ? `restore from backup ${backup}` : 'target was not modified');
    }
  }

  readAudit(limit = 200): AuditRow[] {
    return this.opts.audit.read(limit);
  }

  /** Audit line for an allow-class endpoint write (no card, still logged). */
  auditAllowed(surface: string, detail: Record<string, unknown>): void {
    this.opts.audit.append({
      ts: new Date(this.now()).toISOString(),
      event: 'allowed',
      surface,
      proposalId: '',
      actor: 'dashboard',
      reason: 'allow-class endpoint (UI click is the intent)',
      diff: [],
      detail,
    });
  }

  private audit(input: {
    event: AuditRow['event'];
    proposal: Proposal;
    actor?: string;
    backup?: string;
    error?: string;
  }): void {
    // allow-mode apply() writes one "allowed" row itself; suppress the
    // intermediate proposed/confirmed rows but always keep failures
    if (this.applying && input.event !== 'failed' && input.event !== 'expired') return;
    this.opts.audit.append({
      ts: new Date(this.now()).toISOString(),
      event: input.event,
      surface: input.proposal.surfaceId,
      proposalId: input.proposal.id,
      actor: input.actor ?? 'dashboard',
      reason: input.proposal.reason,
      diff: input.proposal.diff,
      ...(input.backup ? { backup: input.backup } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
  }
}

export class GateError extends Error {
  status: number;
  fix: string;
  constructor(status: number, message: string, fix: string) {
    super(message);
    this.status = status;
    this.fix = fix;
  }
}
