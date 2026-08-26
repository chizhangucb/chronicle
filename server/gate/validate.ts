/* eslint-disable @typescript-eslint/no-explicit-any -- reason below */
/**
 * Why `any` is allowed in this file:
 * IS the runtime shape checker. It walks arbitrary proposed config objects
 * against a declared shape, so unknown-shaped input is its input type, not a
 * gap in the typing.
 *
 * Ported from Varde (CHI-323 part 2). Chronicle drops Varde's `aggregator-config`
 * schema (its own config file, not a Chronicle surface) and the DEFAULT_CONFIG
 * import; it keeps the hub-write schemas (gate_config / classification / markers),
 * the Tier-2 hermes-approvals schema, and memory-scope (registered by the memory
 * organ). js-yaml is a new runtime dep (D9 NOTICE).
 */
import yaml from 'js-yaml';
import type { DiffEntry } from './core.ts';

export interface Verdict {
  ok: boolean;
  errors: string[];
}

type SchemaImpl = {
  /** Merge a change payload over the current file text, return the new text + diff. */
  apply(currentText: string | null, change: unknown): { after: string; diff: DiffEntry[] };
  /** Validate a full resulting file text. */
  validate(text: string): Verdict;
  /** What the browser may see of the current file. Defaults to the raw text;
   * schemas over files that also hold secrets (config.yaml) extract only their
   * editable block. */
  view?(text: string | null): string | null;
};

export function jsonDiff(before: any, after: any, path = '', out: DiffEntry[] = []): DiffEntry[] {
  const isPlain = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);
  // Recurse when both sides are objects, and also when ONE side is an object
  // and the other absent: a first-time nested write then diffs leaf by leaf
  // ("briefing.cadence: unset -> weekly") instead of dumping a JSON blob.
  if (
    (isPlain(before) || isPlain(after)) &&
    (before === undefined || isPlain(before)) &&
    (after === undefined || isPlain(after))
  ) {
    for (const k of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      jsonDiff(before?.[k], after?.[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path: path || 'root', from: before, to: after });
  }
  return out;
}

function parseJson(text: string | null): { obj: any; error?: string } {
  if (text === null) return { obj: {} };
  try {
    return { obj: JSON.parse(text) };
  } catch (err) {
    return { obj: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function replaceWhole(label: string): SchemaImpl['apply'] {
  return (currentText, change) => {
    if (typeof change !== 'object' || change === null || Array.isArray(change)) {
      throw new Error(`change for ${label} must be the complete new object`);
    }
    const { obj, error } = parseJson(currentText);
    if (error) throw new Error(`current ${label} is unparseable (${error}); fix it hub-side first`);
    return { after: JSON.stringify(change, null, 2) + '\n', diff: jsonDiff(obj ?? {}, change) };
  };
}

const schemas: Record<string, SchemaImpl> = {
  // Hub gate_config.json (spend caps + kill switch): named-key merge. Absent key
  // keeps the default; explicit null unsets a cap. The file belongs to the GATE,
  // not to Chronicle: it grows keys we have never heard of, so the CHANGE is held
  // to the managed-key whitelist while foreign keys in the resulting file pass
  // through untouched (rejecting them would freeze the kill switch on a newer gate).
  'hub-gate-config': {
    apply(currentText, change) {
      const { obj, error } = parseJson(currentText);
      if (error) throw new Error(`current gate_config.json is unparseable (${error}); fix it hub-side first`);
      if (typeof change !== 'object' || change === null || Array.isArray(change)) {
        throw new Error('change for gate_config.json must be an object of managed keys');
      }
      const managed = ['spend_per_tx_cap', 'spend_per_session_cap', 'enabled'];
      for (const key of Object.keys(change)) {
        if (!managed.includes(key)) {
          throw new Error(`${key}: not a key this surface manages (${managed.join(', ')})`);
        }
      }
      const next = { ...(obj ?? {}), ...change };
      return { after: JSON.stringify(next, null, 2) + '\n', diff: jsonDiff(obj ?? {}, next) };
    },
    validate(text) {
      const { obj, error } = parseJson(text);
      if (error) return { ok: false, errors: [`not valid JSON: ${error}`] };
      const errors: string[] = [];
      for (const [key, val] of Object.entries<any>(obj ?? {})) {
        if (key === 'spend_per_tx_cap' || key === 'spend_per_session_cap') {
          if (val !== null && (typeof val !== 'number' || !Number.isFinite(val))) errors.push(`${key}: expected number or null`);
          else if (typeof val === 'number' && val < 0) errors.push(`${key}: negative cap makes no sense`);
        } else if (key === 'enabled') {
          if (typeof val !== 'boolean') errors.push('enabled: expected boolean');
        }
        // Anything else is the gate's own business: pass through unvalidated.
      }
      return { ok: errors.length === 0, errors };
    },
  },

  // Memory scope (used by the memory organ, 1g): living/historical/excluded glob
  // lists + rot thresholds. Named-key merge; every other key in the target file
  // passes through untouched. Self-contained (no Chronicle-specific imports), so
  // it ports now and the memory surface registers it later.
  'memory-scope': {
    apply(currentText, change) {
      const { obj, error } = parseJson(currentText);
      if (error) throw new Error(`current memory config is unparseable (${error}); fix it by hand first`);
      if (typeof change !== 'object' || change === null || Array.isArray(change)) {
        throw new Error('change for memory-scope must be an object of managed keys');
      }
      const managed = ['scope', 'rotDays', 'rotDaysByKind'];
      for (const key of Object.keys(change)) {
        if (!managed.includes(key)) {
          throw new Error(`${key}: not a key this surface manages (${managed.join(', ')})`);
        }
      }
      const c = change as Record<string, unknown>;
      if (c.scope !== undefined) {
        if (typeof c.scope !== 'object' || c.scope === null || Array.isArray(c.scope)) {
          throw new Error('scope: expected an object with living/historical/excluded lists');
        }
        for (const key of Object.keys(c.scope)) {
          if (!['living', 'historical', 'excluded'].includes(key)) {
            throw new Error(`scope.${key}: not a tier (living, historical, excluded)`);
          }
        }
      }
      const beforeMemory = typeof obj?.memory === 'object' && obj.memory !== null ? obj.memory : {};
      const nextMemory = {
        ...beforeMemory,
        ...(c.rotDays !== undefined ? { rotDays: c.rotDays } : {}),
        ...(c.rotDaysByKind !== undefined ? { rotDaysByKind: c.rotDaysByKind } : {}),
        ...(c.scope !== undefined
          ? { scope: { ...(beforeMemory.scope ?? {}), ...(c.scope as object) } }
          : {}),
      };
      const next = { ...(obj ?? {}), memory: nextMemory };
      return {
        after: JSON.stringify(next, null, 2) + '\n',
        diff: jsonDiff(beforeMemory, nextMemory, 'memory'),
      };
    },
    validate(text) {
      const { obj, error } = parseJson(text);
      if (error) return { ok: false, errors: [`not valid JSON: ${error}`] };
      const errors: string[] = [];
      const memory = obj?.memory;
      if (memory !== undefined) {
        if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) {
          return { ok: false, errors: ['memory: expected an object'] };
        }
        if (memory.scope !== undefined) {
          if (typeof memory.scope !== 'object' || memory.scope === null || Array.isArray(memory.scope)) {
            errors.push('memory.scope: expected an object');
          } else {
            for (const tier of ['living', 'historical', 'excluded']) {
              const list = memory.scope[tier];
              if (list === undefined) continue;
              if (!Array.isArray(list) || !list.every((v: unknown) => typeof v === 'string' && v.trim())) {
                errors.push(`memory.scope.${tier}: expected a list of non-empty glob strings`);
              } else if (list.some((v: string) => v.includes('..') || v.startsWith('/'))) {
                errors.push(`memory.scope.${tier}: globs are hub-relative (no absolute paths, no ..)`);
              }
            }
          }
        }
        if (memory.rotDays !== undefined) {
          if (typeof memory.rotDays !== 'number' || !Number.isFinite(memory.rotDays) || memory.rotDays <= 0) {
            errors.push('memory.rotDays: expected a positive number of days');
          }
        }
        if (memory.rotDaysByKind !== undefined) {
          if (typeof memory.rotDaysByKind !== 'object' || memory.rotDaysByKind === null || Array.isArray(memory.rotDaysByKind)) {
            errors.push('memory.rotDaysByKind: expected an object map');
          } else {
            for (const [kind, days] of Object.entries<any>(memory.rotDaysByKind)) {
              if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
                errors.push(`memory.rotDaysByKind.${kind}: expected a positive number of days`);
              }
            }
          }
        }
      }
      return { ok: errors.length === 0, errors };
    },
  },

  // Hub classification.json and confidential_markers.json: structural files, so
  // the change payload is the COMPLETE new object (never a partial merge; the
  // diff on the card shows exactly what moved).
  'hub-classification': {
    apply: replaceWhole('classification.json'),
    validate(text) {
      const { obj, error } = parseJson(text);
      if (error) return { ok: false, errors: [`not valid JSON: ${error}`] };
      const errors: string[] = [];
      const tools = obj?.tools;
      if (typeof tools !== 'object' || tools === null || Object.keys(tools).length === 0) {
        errors.push('tools: expected a non-empty object map');
      } else {
        for (const [name, spec] of Object.entries<any>(tools)) {
          if (typeof spec !== 'object' || spec === null) errors.push(`tools.${name}: expected object`);
          else if (!['read', 'send', 'publish', 'spend'].includes(spec.class)) {
            errors.push(`tools.${name}.class: expected read|send|publish|spend`);
          }
        }
      }
      return { ok: errors.length === 0, errors };
    },
  },

  'hub-confidential-markers': {
    apply: replaceWhole('confidential_markers.json'),
    validate(text) {
      const { obj, error } = parseJson(text);
      if (error) return { ok: false, errors: [`not valid JSON: ${error}`] };
      const errors: string[] = [];
      for (const key of ['strong', 'ambiguous']) {
        const vals = obj?.[key];
        if (!Array.isArray(vals) || !vals.every((v: unknown) => typeof v === 'string' && v.trim())) {
          errors.push(`${key}: expected a list of non-empty strings`);
        }
      }
      return { ok: errors.length === 0, errors };
    },
  },

  // ~/.hermes/config.yaml approvals block (deny globs + approval posture). The
  // ONLY Tier 2 surface. Merge-write: every other key in config.yaml is
  // untouched. The browser only ever sees the approvals block (view), never the
  // full file, which can hold provider keys.
  'hermes-approvals': {
    apply(currentText, change) {
      if (currentText === null) throw new Error('no ~/.hermes/config.yaml - run `hermes setup` first');
      let cfg: any;
      try {
        cfg = yaml.load(currentText) ?? {};
      } catch (err) {
        throw new Error(`current config.yaml is unparseable (${err instanceof Error ? err.message : err}); fix it by hand first`);
      }
      if (typeof change !== 'object' || change === null || Array.isArray(change)) {
        throw new Error('change must be the approvals object (partial or full)');
      }
      const managedApprovalKeys = ['mode', 'cron_mode', 'timeout', 'destructive_slash_confirm', 'deny'];
      for (const key of Object.keys(change)) {
        if (!managedApprovalKeys.includes(key)) {
          throw new Error(`${key}: not a key this surface manages (${managedApprovalKeys.join(', ')})`);
        }
      }
      const before = typeof cfg.approvals === 'object' && cfg.approvals !== null ? cfg.approvals : {};
      const next = { ...before, ...(change as Record<string, unknown>) };
      const out = { ...cfg, approvals: next };
      return {
        after: yaml.dump(out, { lineWidth: 120, noRefs: true }),
        diff: jsonDiff(before, next, 'approvals'),
      };
    },
    validate(text) {
      let cfg: any;
      try {
        cfg = yaml.load(text) ?? {};
      } catch (err) {
        return { ok: false, errors: [`not valid YAML: ${err instanceof Error ? err.message : err}`] };
      }
      const a = cfg.approvals;
      if (typeof a !== 'object' || a === null) return { ok: false, errors: ['approvals: expected an object'] };
      const errors: string[] = [];
      for (const [key, val] of Object.entries<any>(a)) {
        if (key === 'mode' || key === 'cron_mode') {
          if (typeof val !== 'string' || !val.trim()) errors.push(`approvals.${key}: expected non-empty string`);
        } else if (key === 'timeout') {
          if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) errors.push('approvals.timeout: expected positive number');
        } else if (key === 'destructive_slash_confirm') {
          if (typeof val !== 'boolean') errors.push(`approvals.${key}: expected boolean`);
        } else if (key === 'deny') {
          if (!Array.isArray(val)) errors.push('approvals.deny: expected a list of globs');
          else {
            for (const g of val) {
              if (typeof g !== 'string' || !g.trim()) errors.push('approvals.deny: empty glob');
              else if (/^[*?\s]+$/.test(g)) errors.push(`approvals.deny: glob "${g}" is wildcards only (would match everything); name the command`);
            }
          }
        }
        // Unknown approvals keys are Hermes's own; they pass through unvalidated.
      }
      return { ok: errors.length === 0, errors };
    },
    view(text) {
      if (text === null) return null;
      try {
        const cfg: any = yaml.load(text) ?? {};
        return JSON.stringify(cfg.approvals ?? {}, null, 2);
      } catch {
        return null;
      }
    },
  },
};

export function applyChange(schema: string, currentText: string | null, change: unknown) {
  const impl = schemas[schema];
  if (!impl) throw new Error(`no validator registered for schema "${schema}"`);
  return impl.apply(currentText, change);
}

export function validate(schema: string, text: string): Verdict {
  const impl = schemas[schema];
  if (!impl) return { ok: false, errors: [`no validator registered for schema "${schema}"`] };
  return impl.validate(text);
}

/** Browser-safe view of a surface's current content (see SchemaImpl.view). */
export function viewOf(schema: string, text: string | null): string | null {
  const impl = schemas[schema];
  return impl?.view ? impl.view(text) : text;
}
