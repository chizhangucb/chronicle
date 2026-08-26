/**
 * The gate between a headless briefing run and briefing.json (ported from Varde,
 * CHI-323 3d). The model's output is nondeterministic; nothing lands on disk
 * unless it passes this file. Pure, no I/O. Strict per card, lenient per file: a
 * malformed card is dropped with reasons; the run fails outright only when the
 * payload is not the contract shape or every card was invalid.
 *
 * D7: "spend" is NOT a valid domain this phase, so a spend card is rejected here
 * — the phase-1 briefing carries the non-spend cards only.
 */
import type { BriefingCard, BriefingDomain } from './briefing.ts';

export const DOMAINS: BriefingDomain[] = ['memory', 'sessions', 'safety', 'jobs', 'coverage'];
export const MAX_CARDS = 12;
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,119}$/i;

export interface CardVerdict { index: number; errors: string[] }
export interface BriefingValidation { cards: BriefingCard[]; dropped: CardVerdict[]; errors: string[] }

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function checkCard(raw: unknown, runAt: string): { card?: BriefingCard; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { errors: ['not an object'] };
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) errors.push('id: expected a stable slug (letters, digits, . _ : -)');
  if (!isStr(c.kind, 60)) errors.push('kind: expected a short machine-readable string');
  if (!DOMAINS.includes(c.domain as BriefingDomain)) errors.push(`domain: expected one of ${DOMAINS.join(', ')}`);
  if (typeof c.needsYou !== 'boolean') errors.push('needsYou: expected a boolean');
  if (!isStr(c.title, 160)) errors.push('title: expected one non-empty line (max 160 chars)');
  if (!isStr(c.summary, 600)) errors.push('summary: expected one or two sentences (max 600 chars)');
  if (c.body !== undefined && !isStr(c.body, 4000)) errors.push('body: when present, a non-empty string (max 4000 chars)');
  for (const [key, max] of [['whatHappened', 600], ['whatItMeans', 600], ['whatToDo', 400], ['evidence', 2000]] as const) {
    if (c[key] !== undefined && !isStr(c[key], max)) errors.push(`${key}: when present, a non-empty string (max ${max} chars)`);
  }

  let link: BriefingCard['link'];
  if (c.link !== undefined) {
    const l = c.link as Record<string, unknown>;
    if (typeof l !== 'object' || l === null || !isStr(l.label, 80) ||
        typeof l.to !== 'string' || !/^\/(?!\/)[a-z0-9/?&=._%-]*$/i.test(l.to) || l.to.length > 200) {
      errors.push('link: expected { label, to } with an internal route path');
    } else {
      link = { label: (l.label as string).trim(), to: l.to };
    }
  }

  let launch: BriefingCard['launch'];
  if (c.launch !== undefined) {
    const l = c.launch as Record<string, unknown>;
    if (typeof l !== 'object' || l === null || !isStr(l.prompt, 2000)) {
      errors.push('launch: expected { prompt } (max 2000 chars)');
    } else if (l.cwd !== undefined && (!isStr(l.cwd, 300) || !/^[/~]/.test(l.cwd as string))) {
      errors.push('launch.cwd: when present, an absolute or ~ path');
    } else {
      launch = { prompt: (l.prompt as string).trim(), ...(l.cwd !== undefined ? { cwd: l.cwd as string } : {}) };
    }
  }

  if (errors.length) return { errors };
  return {
    errors,
    card: {
      id: c.id as string, runAt, kind: (c.kind as string).trim(), domain: c.domain as BriefingDomain,
      needsYou: c.needsYou as boolean, title: (c.title as string).trim(), summary: (c.summary as string).trim(),
      ...(c.body !== undefined ? { body: (c.body as string).trim() } : {}),
      ...(c.whatHappened !== undefined ? { whatHappened: (c.whatHappened as string).trim() } : {}),
      ...(c.whatItMeans !== undefined ? { whatItMeans: (c.whatItMeans as string).trim() } : {}),
      ...(c.whatToDo !== undefined ? { whatToDo: (c.whatToDo as string).trim() } : {}),
      ...(c.evidence !== undefined ? { evidence: (c.evidence as string).trim() } : {}),
      ...(link ? { link } : {}),
      ...(launch ? { launch } : {}),
    },
  };
}

export function validateBriefingRun(value: unknown, now: Date): BriefingValidation {
  const out: BriefingValidation = { cards: [], dropped: [], errors: [] };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.errors.push('payload is not an object');
    return out;
  }
  const cards = (value as Record<string, unknown>).cards;
  if (!Array.isArray(cards)) {
    out.errors.push('payload.cards is not an array');
    return out;
  }
  const runAt = now.toISOString();
  const seen = new Set<string>();
  cards.forEach((raw, index) => {
    if (out.cards.length >= MAX_CARDS) { out.dropped.push({ index, errors: [`over the ${MAX_CARDS}-card cap (padded run?)`] }); return; }
    const { card, errors } = checkCard(raw, runAt);
    if (!card) { out.dropped.push({ index, errors }); return; }
    if (seen.has(card.id)) { out.dropped.push({ index, errors: [`duplicate id "${card.id}"`] }); return; }
    seen.add(card.id);
    out.cards.push(card);
  });
  if (cards.length > 0 && out.cards.length === 0) out.errors.push('every card was invalid; refusing to overwrite the last good briefing');
  return out;
}

/** Pull the JSON object out of a model reply that may carry fences or prose. */
export function extractJson(text: string): unknown {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { continue; }
  }
  throw new Error('no parseable JSON object in the run output');
}

/** Cadence skip rule. Only "weekly" changes the rule; other cadences ride their
 * launchd schedule. Run-now bypasses this with force. */
export function isDue(cadence: string, lastGeneratedAt: string | null, now: Date): boolean {
  if (cadence !== 'weekly') return true;
  if (!lastGeneratedAt) return true;
  const last = new Date(lastGeneratedAt).getTime();
  if (!Number.isFinite(last)) return true;
  const ageDays = (now.getTime() - last) / 86_400_000;
  if (ageDays >= 7) return true;
  return now.getDay() === 1 && ageDays >= 1;
}
