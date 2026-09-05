import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { validate, applyChange, jsonDiff } from './validate.ts';

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
  secondChannel: string | null;
  /** "file" (default) writes the target; "action" runs a registered ActionImpl
   * (e.g. launchd pause/resume). Same card + audit either way. */
  kind?: 'file' | 'action';
  /**
   * CHI-329. Whether a change on this surface needs the human confirm card.
   * ABSENT MEANS "confirm": a surface that forgets to declare a posture gets
   * the card. Fail closed, always.
   *
   * "auto" runs the whole validate -> backup -> write -> verify pipeline in one
   * call with a single "allowed" audit row. The per-boot token still guards it;
   * only the human-confirm step is tiered.
   */
  approval?: 'auto' | 'confirm';
  /**
   * CHI-329. Per-CHANGE narrowing, MONOTONIC BY CONSTRUCTION: it may turn an
   * "auto" surface into a card for one particular change, and can never do the
   * reverse. Returns the plain-language reason to show on the card, or null to
   * leave the surface's declared posture alone.
   *
   * The one-way property is the whole point. CHI-329 rev 1 tried two-way
   * direction-aware rules (auto a "tightening" change on a confirm surface) and
   * the adversarial review broke them: `hub-spend-caps` and `hub-egress-enabled`
   * share one schema over one file, and applyChange is called with
   * surface.schema, never surface.id, so a "tightening" cap decrease could
   * legally carry a kill-switch re-enable past the rule meant to card it. A
   * narrowing that only ever ADDS a card has no such failure mode.
   */
  narrow?: (change: unknown, diff: DiffEntry[]) => string | null;
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
  /** Where the change came from (CHI-329). Recorded on the audit row. */
  source?: ChangeSource;
  /** Tier 2: one-time code delivered over the second channel. Never serialized
   * to the browser; the transport strips it. */
  secondFactor?: string;
  /** Tier 2 marker for the card UI: confirm needs the code. */
  requiresCode?: boolean;
  /** CHI-329: why this change is showing a card rather than auto-applying.
   * Plain language, shown on the card (CHI-378's card-UX rule: say why). */
  cardReason?: string;
  createdAt: string;
  expiresAt: string;
}

/** CHI-329: the outcome of the tiering decision for ONE change. */
export interface ApprovalVerdict {
  auto: boolean;
  /** Set whenever auto is false; plain language, shown on the card. */
  cardReason?: string;
}

/** Provenance of a change, supplied by the caller. NOT a security boundary:
 * the gate token is fetchable by any local process (routes.ts), so a caller
 * that wanted to lie could equally POST the change directly. It exists so the
 * app's own model-generated payloads keep their human-review card, which
 * spec/surface-contract.md requires of headless-LLM output. */
export type ChangeSource = 'operator' | 'suggestion';

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

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** What a completed write reports back. */
export interface ApplyResult {
  applied: string;
  backup: string | null;
  target: string;
  diff: DiffEntry[];
}

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
  /** Demo mode (CHRONICLE_DEMO=1): the gate is inert for WRITES. Every surface
   * renders unavailable and propose/apply/confirm refuse (409), so a demo build
   * never touches real machine state (e.g. ~/.hermes/config.yaml, launchd) even
   * for surfaces that resolve against ${HOME}. Reads (the safety posture) still
   * show synthetic data. Part 4 fail-closed. */
  demo?: boolean;
  now?: () => number;
}

export class Gate {
  readonly token = randomBytes(32).toString('hex');
  private proposals = new Map<string, Proposal>();
  private opts: GateOptions;

  constructor(opts: GateOptions) {
    this.opts = opts;
    // CHI-329 floor 3, enforced at construction so a bad registry row can never
    // ship: a satellite NEVER auto-writes the hub. A loud throw, not a silent
    // downgrade to confirm, because a row declaring auto here means whoever
    // wrote it misunderstood the boundary and should hear about it.
    for (const s of opts.surfaces) {
      if (s.approval === 'auto' && s.writeVia === 'hub-script') {
        throw new Error(
          `gate surface "${s.id}" declares approval:auto with writeVia:hub-script. ` +
          'A satellite never auto-writes the hub; drop the auto or the hub-script.',
        );
      }
    }
  }

  /**
   * CHI-329: the ONE tiering decision. Both propose() and apply() call this
   * exactly once and neither re-enters the other, so there is a single place a
   * change can be classified and no way for a client to reach a softer path by
   * picking a different endpoint.
   *
   * Runs on a VALIDATED diff only (callers invoke it after applyChange +
   * validate + the no-op check), so a narrow() never sees unparsed garbage.
   */
  resolveApproval(surface: Surface, change: unknown, diff: DiffEntry[], source: ChangeSource = 'operator'): ApprovalVerdict {
    // Floor 1: absent posture means the card.
    if (surface.approval !== 'auto') {
      return { auto: false, cardReason: 'this surface always shows the card' };
    }
    // Floor 1b: machine-generated content is reviewed by a human, on every
    // surface. spec/surface-contract.md requires the card to BE the review step
    // for anything a headless `claude -p` runner writes. Auto-approving it
    // would delete a signed clause, so this is a floor, not a per-surface case.
    if (source === 'suggestion') {
      return { auto: false, cardReason: 'this change was generated by a model, so a human reviews the diff' };
    }
    // Floor 2: Tier 2 is the second-channel surface; the code IS the point.
    if (surface.tier === 2) {
      return { auto: false, cardReason: 'Tier 2 surface: confirming needs the code from the Telegram card' };
    }
    // Floor 3: belt to the constructor's braces.
    if (surface.writeVia === 'hub-script') {
      return { auto: false, cardReason: 'writes the hub through its own entry point; a satellite never auto-writes the hub' };
    }
    // Floor 5: a narrow() that throws cards. Fail closed, never fail open.
    if (surface.narrow) {
      let reason: string | null;
      try {
        reason = surface.narrow(change, diff);
      } catch (err) {
        return {
          auto: false,
          cardReason: `could not classify this change (${err instanceof Error ? err.message : String(err)}), so it needs the card`,
        };
      }
      if (reason) return { auto: false, cardReason: reason };
    }
    return { auto: true };
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
      if (this.opts.demo) {
        return { ...s, resolvedTarget, available: false, unavailableReason: 'demo seed, gate writes are disabled' };
      }
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
          // Say the real reason (CHI-395): on a machine WITH a hub checkout this
          // is almost always the missing entry point, not a missing hub. The
          // hub deleted scripts/egress_gate/apply_edit.py in CHI-253 as an
          // unused script; Chronicle was its one caller. A generic "no hub
          // checkout" here sent the last reader looking in the wrong place.
          return {
            ...s,
            resolvedTarget,
            available: false,
            unavailableReason: this.opts.hubRoot
              ? 'the hub has no scripts/egress_gate/apply_edit.py, so there is no entry point to write through (CHI-395)'
              : 'hub entry point not configured (no hub checkout)',
          };
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

  /**
   * Build a validated, un-stored, un-audited proposal. The shared front half of
   * every write path: it runs applyChange -> validate -> no-op check, so by the
   * time anything classifies or writes this change, the diff is real.
   * Invalid input is a loud error here and no card is ever shown.
   */
  private build(surface: SurfaceStatus, text: string | null, change: unknown, reason: string, source: ChangeSource): Proposal {
    if (this.opts.demo) throw new GateError(409, 'demo seed, gate writes are disabled', 'run on a real console with a hub');
    const createdAt = this.now();
    const base = {
      id: randomBytes(12).toString('hex'),
      surfaceId: surface.id,
      reason: String(reason ?? '').trim() || '(no reason given)',
      source,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + PROPOSAL_TTL_MS).toISOString(),
    };
    if (surface.kind === 'action') {
      const diff = this.opts.actions![surface.id].describe(change);
      if (diff.length === 0) throw new GateError(400, 'action is a no-op', 'nothing to confirm');
      return { ...base, before: null, after: '', diff, change };
    }
    const applied = applyChange(surface.schema, text, change);
    const verdict = validate(surface.schema, applied.after);
    if (!verdict.ok) {
      throw new GateError(
        400,
        `invalid change for "${surface.id}": ${verdict.errors.join('; ')}`,
        'fix the listed fields and propose again',
      );
    }
    if (applied.diff.length === 0) {
      throw new GateError(400, 'change is a no-op: resulting file is identical', 'nothing to confirm');
    }
    return { ...base, before: text, after: applied.after, diff: applied.diff };
  }

  /** Step 1 of the card flow. Validates the RESULTING file; invalid input is a
   * loud error and no card is ever shown (nothing is stored). Always produces a
   * card: callers wanting the tiering decision use submit(). */
  propose(surfaceId: string, change: unknown, reason: string, source: ChangeSource = 'operator'): Proposal {
    const { surface, text } = this.readSurface(surfaceId);
    const proposal = this.build(surface, text, change, reason, source);
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

  /**
   * The single public entry point for a write request (CHI-329 WP2). Decides
   * ONCE via resolveApproval, then takes exactly one of the two paths. The
   * client cannot reach a softer path by choosing a different endpoint,
   * because it never makes the choice.
   */
  submit(
    surfaceId: string,
    change: unknown,
    reason: string,
    source: ChangeSource = 'operator',
    actor = 'operator',
  ): { applied: true; result: ApplyResult } | { applied: false; proposal: Proposal } {
    const { surface, text } = this.readSurface(surfaceId);
    const built = this.build(surface, text, change, reason, source);
    const verdict = this.resolveApproval(surface, change, built.diff, source);
    if (verdict.auto) {
      return { applied: true, result: { ...this.settle(built, actor, 'allowed'), diff: built.diff } };
    }
    built.cardReason = verdict.cardReason;
    this.finalizeTier2(surface, built);
    this.proposals.set(built.id, built);
    this.audit({ event: 'proposed', proposal: built });
    return { applied: false, proposal: built };
  }

  /** One-shot write, auto-classified changes only: the same validate -> backup
   * -> write -> verify pipeline as propose+confirm, audited as one "allowed"
   * row with the diff. Refuses anything the policy says needs the card.
   * Does NOT route through propose()/confirm(): a proposal is never stored, so
   * there is no card to expire and no second audit row to suppress. */
  apply(surfaceId: string, change: unknown, reason: string, actor = 'operator', source: ChangeSource = 'operator'): ApplyResult {
    const { surface, text } = this.readSurface(surfaceId);
    const built = this.build(surface, text, change, reason, source);
    const verdict = this.resolveApproval(surface, change, built.diff, source);
    if (!verdict.auto) {
      throw new GateError(403, `surface "${surfaceId}" requires the confirm card: ${verdict.cardReason}`, 'use propose + confirm');
    }
    return { ...this.settle(built, actor, 'allowed'), diff: built.diff };
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
    this.proposals.delete(proposalId);
    return this.settle(p, actor, 'confirmed');
  }

  /**
   * The shared write half: backup -> write -> verify -> audit, for a proposal
   * that has already been classified and (if carded) confirmed. Never touches
   * the proposals map; callers own that.
   *
   * `event` is the row this writes on success: "confirmed" after a card,
   * "allowed" for an auto-approved change. There is no suppression flag: the
   * auto path stores no proposal and emits exactly one row, so two concurrent
   * auto-applies can no longer swallow each other's audit (CHI-329 WP3).
   */
  private settle(p: Proposal, actor: string, event: 'confirmed' | 'allowed'): { applied: string; backup: string | null; target: string } {
    const { surface, text } = this.readSurface(p.surfaceId);
    if (surface.kind === 'action') {
      try {
        const applied = this.opts.actions![surface.id].execute(p.change);
        this.audit({ event, proposal: p, actor });
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
      this.audit({ event: 'failed', proposal: p, actor, error: 'target changed since the card was shown' });
      throw new GateError(409, 'target file changed since the proposal was made', 're-propose against the current file');
    }
    if (surface.writeVia === 'hub-script') {
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
        this.audit({ event, proposal: p, actor, backup: result.backup });
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
      // CHI-329 WP4: the backup's content hash rides the audit row so an undo
      // can prove the .bak still holds what we wrote it from. Backups are
      // ordinary user-writable files and validate() is only a shape check, so a
      // tampered-but-well-formed config would otherwise restore cleanly.
      this.audit({
        event,
        proposal: p,
        actor,
        backup: backup ?? undefined,
        ...(backup && text !== null ? { detail: { backupSha256: sha256(text) } } : {}),
      });
      return { applied: landed, backup, target };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ event: 'failed', proposal: p, actor, backup: backup ?? undefined, error: msg });
      throw new GateError(500, `write failed: ${msg}`, backup ? `restore from backup ${backup}` : 'target was not modified');
    }
  }

  readAudit(limit = 200): AuditRow[] {
    return this.opts.audit.read(limit);
  }

  /**
   * Restore a surface from the backup a previous write took (CHI-329 WP4).
   *
   * Two properties the adversarial review insisted on, both load-bearing:
   *
   * 1. UNDO IS NOT AN APPROVAL CATEGORY. The restore is submitted as an
   *    ordinary change, so it meets the same policy as any other write. Rev 1
   *    proposed "undo of an auto row is itself auto, because restoring a prior
   *    state is tightening" - which is false, and gave a clean two-step floor
   *    bypass: auto-approve a tightening change, undo it, and the loosening
   *    lands with no card ever shown.
   * 2. THE BACKUP IS VERIFIED. `.bak` files are ordinary user-writable files,
   *    and validate() checks shape, not content: a permissive-but-well-formed
   *    config passes it happily. We compare the backup against the sha256
   *    recorded on the audit row at write time and refuse on any mismatch.
   */
  undo(proposalId: string): { applied: true; result: ApplyResult } | { applied: false; proposal: Proposal } {
    const row = this.opts.audit.read(500).find((r) => r.proposalId === proposalId && (r.event === 'confirmed' || r.event === 'allowed'));
    if (!row) throw new GateError(404, 'no completed write with that id in the audit trail', 'pick a row that actually wrote something');
    if (!row.backup) {
      throw new GateError(409, 'that write took no backup, so there is nothing to restore from', 'a launchd pause/resume is undone by the opposite action, not by this route');
    }
    const surface = this.listSurfaces().find((s) => s.id === row.surface);
    if (!surface) throw new GateError(404, `unknown surface "${row.surface}"`, 'check server/gate/surfaces.ts');
    if (surface.writeVia === 'hub-script') {
      // The backup path came from the hub runner; it is a hub-side file this
      // satellite never created and cannot vouch for.
      throw new GateError(409, 'hub writes are undone hub-side, not from here', `restore ${row.backup} in the hub checkout`);
    }
    if (!existsSync(row.backup)) {
      throw new GateError(410, `backup ${row.backup} is gone`, 'nothing to restore; the file was removed or the app home was cleared');
    }
    const restored = readFileSync(row.backup, 'utf-8');
    const expected = (row.detail as { backupSha256?: unknown } | undefined)?.backupSha256;
    if (typeof expected !== 'string') {
      throw new GateError(409, 'that write predates backup hashing, so the backup cannot be verified', 'restore it by hand if you are sure of its contents');
    }
    if (sha256(restored) !== expected) {
      throw new GateError(
        409,
        'the backup file has changed since it was written, so it will not be restored',
        `inspect ${row.backup} by hand; the gate will not write content it cannot vouch for`,
      );
    }
    // Restore by CONTENT, not by replaying a change payload: the schemas are
    // merge-based with managed-key whitelists, so a whole backup body is not a
    // legal `change` for most of them. Diffing the two texts sidesteps that
    // entirely, and still runs validate + the policy before anything is written.
    const current = existsSync(surface.resolvedTarget!) ? readFileSync(surface.resolvedTarget!, 'utf-8') : null;
    let diff: DiffEntry[];
    try {
      diff = jsonDiff(current === null ? {} : JSON.parse(current), JSON.parse(restored));
    } catch {
      throw new GateError(409, 'this surface is not a JSON file, so it cannot be undone from here', `restore ${row.backup} by hand`);
    }
    if (diff.length === 0) {
      throw new GateError(400, 'nothing to undo: the file already matches the backup', 'no write is needed');
    }
    const verdict = validate(surface.schema, restored);
    if (!verdict.ok) {
      throw new GateError(409, `the backup does not validate: ${verdict.errors.join('; ')}`, 'restore it by hand after fixing it');
    }
    const p: Proposal = {
      id: randomBytes(12).toString('hex'),
      surfaceId: surface.id,
      reason: `undo of the ${row.event} write at ${row.ts}`,
      source: 'operator',
      before: current,
      after: restored,
      diff,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + PROPOSAL_TTL_MS).toISOString(),
    };
    const policy = this.resolveApproval(surface, undefined, diff, 'operator');
    if (policy.auto) {
      return { applied: true, result: { ...this.settle(p, 'operator', 'allowed'), diff } };
    }
    p.cardReason = policy.cardReason;
    this.finalizeTier2(surface, p);
    this.proposals.set(p.id, p);
    this.audit({ event: 'proposed', proposal: p });
    return { applied: false, proposal: p };
  }

  /** Audit line for a write that does not go through a gate Surface (CHI-396:
   * the app's own routes). `event` is "allowed" for a write that happened and
   * "failed" for one that blew up mid-flight; there is no diff, because these
   * writes are not diffable the way a config edit is. */
  auditAllowed(surface: string, detail: Record<string, unknown>, event: 'allowed' | 'failed' = 'allowed'): void {
    this.opts.audit.append({
      ts: new Date(this.now()).toISOString(),
      event,
      surface,
      proposalId: '',
      actor: 'dashboard',
      reason: event === 'failed' ? 'app write failed mid-request' : 'app write (the UI click is the intent)',
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
    detail?: Record<string, unknown>;
  }): void {
    const p = input.proposal;
    const detail = {
      ...(input.detail ?? {}),
      ...(p.source && p.source !== 'operator' ? { source: p.source } : {}),
      ...(p.cardReason ? { cardReason: p.cardReason } : {}),
    };
    this.opts.audit.append({
      ts: new Date(this.now()).toISOString(),
      event: input.event,
      surface: p.surfaceId,
      proposalId: p.id,
      actor: input.actor ?? 'dashboard',
      reason: p.reason,
      diff: p.diff,
      ...(input.backup ? { backup: input.backup } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(Object.keys(detail).length ? { detail } : {}),
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
