/**
 * The briefing-card contract (ported from Varde, CHI-323 3d): what the daily
 * briefing run writes, what the console reads, and where a card's action state
 * lives. Two files, deliberately separate (the grandfathered contract):
 *
 *   <dataDir>/briefing.json        written by the briefing run, never by the UI.
 *   <dataDir>/briefing-state.json  written by the UI only. The operator's action
 *                                  state, survives every briefing run.
 *
 * Keeping them apart means a run can never clobber a "done", and the UI never
 * writes into a source the run owns.
 *
 * SCOPE: the briefing carries jobs / safety / egress / memory / coverage AND
 * spend (CHI-324 2i — the phase-1 D7 gap closed once the spend detector moved
 * server-side; the runner assembles a spend slice via server/spendSnapshot.ts).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { packageRoot } from './hub/paths.ts';

const SHIPPED_DATA_DIR = join(packageRoot(), 'data');
function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');
}

/** Domains a card can belong to. Spend joined in CHI-324 2i (the D7 gap closed
 * once the spend detector moved server-side; see server/spendSnapshot.ts). */
export type BriefingDomain = 'memory' | 'sessions' | 'safety' | 'jobs' | 'coverage' | 'spend';

export interface BriefingCard {
  id: string;
  runAt: string;
  kind: string;
  domain: BriefingDomain;
  needsYou: boolean;
  title: string;
  summary: string;
  body?: string;
  whatHappened?: string;
  whatItMeans?: string;
  whatToDo?: string;
  evidence?: string;
  link?: { label: string; to: string };
  launch?: { prompt: string; cwd?: string };
}

export interface BriefingFile {
  version: 1;
  generatedAt: string;
  cadence: string;
  cards: BriefingCard[];
  isExample?: boolean;
  isDemo?: boolean;
  demoStates?: Record<string, CardStateEntry>;
}

export type CardState = 'open' | 'done' | 'dismissed' | 'snoozed' | 'resolved';

export interface CardStateEntry {
  state: CardState;
  at: string;
  snoozedUntil?: string;
  workedAt?: string;
  ticketRef?: string;
}

export interface BriefingStateFile {
  version: 1;
  cards: Record<string, CardStateEntry>;
}

export const EMPTY_BRIEFING: BriefingFile = { version: 1, generatedAt: '', cadence: 'daily', cards: [], isExample: true };
const EMPTY_STATE: BriefingStateFile = { version: 1, cards: {} };
export const SNOOZE_DAYS = 3;

export function briefingStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'briefing-state.json');
}

function briefingCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.CHRONICLE_BRIEFING_FILE) out.push(resolve(env.CHRONICLE_BRIEFING_FILE));
  if (env.CHRONICLE_DEMO === '1') out.push(join(SHIPPED_DATA_DIR, 'briefing.demo.json'));
  out.push(join(dataDir(env), 'briefing.json'));
  out.push(join(SHIPPED_DATA_DIR, 'briefing.example.json'));
  return out;
}

/** Slide a demo file's fixed dates forward so its newest run reads as `now`. */
export function rebaseDemoDates(file: BriefingFile, now: Date): BriefingFile {
  const stamps = file.cards.map((c) => new Date(c.runAt).getTime()).filter(Number.isFinite);
  if (!stamps.length) return file;
  const shift = now.getTime() - Math.max(...stamps);
  const slide = (iso: string): string => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? new Date(t + shift).toISOString() : iso;
  };
  const slideEntry = (entry: CardStateEntry): CardStateEntry => ({
    ...entry, at: slide(entry.at),
    ...(entry.snoozedUntil ? { snoozedUntil: slide(entry.snoozedUntil) } : {}),
    ...(entry.workedAt ? { workedAt: slide(entry.workedAt) } : {}),
  });
  return {
    ...file,
    generatedAt: file.generatedAt ? slide(file.generatedAt) : new Date(now).toISOString(),
    cards: file.cards.map((card) => ({ ...card, runAt: slide(card.runAt) })),
    ...(file.demoStates
      ? { demoStates: Object.fromEntries(Object.entries(file.demoStates).map(([id, e]) => [id, slideEntry(e)])) }
      : {}),
  };
}

/** First readable briefing file wins; none readable is the pre-first-run state. */
export async function readBriefingFile(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<BriefingFile> {
  for (const path of briefingCandidates(env)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as BriefingFile;
      if (!Array.isArray(parsed.cards)) continue;
      return parsed.isDemo ? rebaseDemoDates(parsed, now) : parsed;
    } catch {
      continue;
    }
  }
  return EMPTY_BRIEFING;
}

/** Overlay a demo file's shipped synthetic state UNDER the operator's real state. */
export function withDemoStates(file: BriefingFile, state: BriefingStateFile): BriefingStateFile {
  if (!file.isDemo || !file.demoStates) return state;
  return { version: 1, cards: { ...file.demoStates, ...state.cards } };
}

export async function readBriefingState(env: NodeJS.ProcessEnv = process.env): Promise<BriefingStateFile> {
  try {
    const parsed = JSON.parse(await readFile(briefingStatePath(env), 'utf-8')) as BriefingStateFile;
    return parsed.cards && typeof parsed.cards === 'object' ? parsed : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

export async function writeBriefingState(state: BriefingStateFile, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = briefingStatePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export type CardAction = 'done' | 'dismiss' | 'snooze' | 'reopen';
export const CARD_ACTIONS: CardAction[] = ['done', 'dismiss', 'snooze', 'reopen'];

/** Pure state transition (testable without disk). Reopen clears the acted state;
 * activity fields (workedAt/ticketRef) survive every transition. */
export function applyCardAction(state: BriefingStateFile, cardId: string, action: CardAction, now: Date): BriefingStateFile {
  const cards = { ...state.cards };
  const prior = cards[cardId];
  const keep = {
    ...(prior?.workedAt ? { workedAt: prior.workedAt } : {}),
    ...(prior?.ticketRef ? { ticketRef: prior.ticketRef } : {}),
  };
  const at = now.toISOString();
  if (action === 'reopen') {
    if (Object.keys(keep).length) cards[cardId] = { state: 'open', at, ...keep };
    else delete cards[cardId];
    return { version: 1, cards };
  }
  if (action === 'snooze') {
    const until = new Date(now.getTime() + SNOOZE_DAYS * 86_400_000);
    cards[cardId] = { state: 'snoozed', at, snoozedUntil: until.toISOString(), ...keep };
    return { version: 1, cards };
  }
  cards[cardId] = { state: action === 'done' ? 'done' : 'dismissed', at, ...keep };
  return { version: 1, cards };
}

/** Record that the operator launched this card into a session. Never changes state. */
export function recordWorkedOn(state: BriefingStateFile, cardId: string, now: Date): BriefingStateFile {
  const cards = { ...state.cards };
  const prior = cards[cardId];
  cards[cardId] = prior ? { ...prior, workedAt: now.toISOString() } : { state: 'open', at: now.toISOString(), workedAt: now.toISOString() };
  return { version: 1, cards };
}

export interface ResolvedCard extends BriefingCard {
  state: CardState;
  actedAt: string | null;
  snoozedUntil: string | null;
  workedAt: string | null;
  ticketRef: string | null;
}

/** Join cards to their state. An expired snooze resolves back to open. */
export function resolveCards(file: BriefingFile, state: BriefingStateFile, now: Date): ResolvedCard[] {
  return file.cards.map((card) => {
    const entry = state.cards[card.id];
    if (!entry) return { ...card, state: 'open', actedAt: null, snoozedUntil: null, workedAt: null, ticketRef: null };
    const expired = entry.state === 'snoozed' && entry.snoozedUntil != null && new Date(entry.snoozedUntil).getTime() <= now.getTime();
    const resolvedState: CardState = expired ? 'open' : entry.state;
    return {
      ...card, state: resolvedState,
      actedAt: resolvedState === 'open' ? null : entry.at,
      snoozedUntil: entry.snoozedUntil ?? null, workedAt: entry.workedAt ?? null, ticketRef: entry.ticketRef ?? null,
    };
  });
}

export interface FollowThrough {
  open: number;
  snoozed: number;
  actedWithinDays: number | null;
  followThroughDays: number;
  medianHoursToAct: number | null;
}
export const FOLLOW_THROUGH_DAYS = 3;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function followThrough(cards: ResolvedCard[], days: number = FOLLOW_THROUGH_DAYS): FollowThrough {
  const acted = cards.filter((c) => (c.state === 'done' || c.state === 'dismissed' || c.state === 'resolved') && c.actedAt);
  const hours = acted
    .map((c) => (new Date(c.actedAt!).getTime() - new Date(c.runAt).getTime()) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0);
  return {
    open: cards.filter((c) => c.state === 'open').length,
    snoozed: cards.filter((c) => c.state === 'snoozed').length,
    actedWithinDays: hours.length ? hours.filter((h) => h <= days * 24).length / hours.length : null,
    followThroughDays: days,
    medianHoursToAct: hours.length ? Math.round(median(hours) * 10) / 10 : null,
  };
}
