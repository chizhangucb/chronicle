#!/usr/bin/env node
/**
 * Memory scope-suggest (CHI-339, the disclosed CHI-323 1g fast-follow): walks
 * the hub's top-level structure NAMES ONLY (never file contents), asks a
 * headless model run for a proposed living/historical/excluded tier mapping
 * as JSON, validates it, and prints it to stdout. The console renders the
 * result as a normal gate diff on the `memory-scope` surface; nothing is
 * written unless the operator confirms that card. Same runner seam as
 * scripts/run-briefing.ts (findClaude, extractJson, an isolated runner cwd).
 *
 * Ported from Varde's scripts/run-scope-suggest.ts, adapted to Chronicle's
 * hub resolution (resolveHub) and data dir (CHRONICLE_DATA_DIR) conventions.
 *
 * Flags: --dry-run (print the command and prompt, run nothing).
 */
import { mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveHub } from '../server/hub/resolve.ts';
import type { MemoryScopePatterns } from '../server/hub/slices/memoryscope.ts';
import { findClaude } from './run-briefing.ts';
import { extractJson } from '../server/briefing-validate.ts';

// Deliberately shorter than run-briefing's 10 min: this run has no tools, no
// file reads, just one short prompt over an already-embedded structure listing.
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
const DATA_DIR = process.env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');

/** Confidential roots never even appear in the structure listing. Kept aligned
 * with memorygraph.ts's NOISE_DIRS (+ confidential/next-ventures, which that
 * file hard-prunes separately). */
const HIDDEN = new Set(['confidential', 'next-ventures', 'node_modules', '.git', '.obsidian']);

function ensureDir(sub = ''): string {
  const dir = sub ? join(DATA_DIR, sub) : DATA_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Two levels of directory NAMES plus root markdown filenames. Deliberately
 * shallow and content-free: the model sees the shape of the hub, nothing in
 * it. Absent hub root -> empty structure (never throws).
 */
export function hubStructure(hubRoot: string | null): string {
  if (!hubRoot) return '';
  const lines: string[] = [];
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((e) => !e.startsWith('.') && !HIDDEN.has(e)).sort();
    } catch {
      return [];
    }
  };
  for (const entry of list(hubRoot)) {
    const full = join(hubRoot, entry);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      const children = list(full)
        .filter((c) => {
          try {
            return lstatSync(join(full, c)).isDirectory() || c.endsWith('.md');
          } catch {
            return false;
          }
        })
        .slice(0, 24);
      lines.push(`${entry}/${children.length ? `  (${children.join(', ')})` : ''}`);
    } else if (entry.endsWith('.md')) {
      lines.push(entry);
    }
  }
  return lines.join('\n');
}

export function buildPrompt(structure: string): string {
  return [
    "You are Chronicle's headless memory-scope suggester. A hub is a personal knowledge repository; Chronicle measures its health in three tiers:",
    '- living: maintained-in-place knowledge (wikis, docs, skills, contact/context/reference notes, root registry .md files). Measured for usage, rot and growth.',
    '- historical: dated append-only records (decision logs, session ledgers, brainstorms, reports, archives, dated ingest material). Used as evidence; never rots.',
    '- excluded: everything else (code, project folders, plans, pipeline machinery/metadata).',
    '',
    'Here is the top-level structure of this hub (directory and file NAMES only):',
    structure || '(empty)',
    '',
    'Propose a tier mapping as glob-ish path prefixes relative to the hub root. Use the names above only; a bare directory name covers everything under it; `*.md` means root markdown files; a trailing `*` matches a filename prefix.',
    'Your entire reply must be exactly one JSON object of the form {"living": [...], "historical": [...], "excluded": [...]} with string arrays. No prose, no markdown fences.',
  ].join('\n');
}

// A scope suggestion IS a MemoryScopePatterns (living/historical/excluded glob
// lists) — reuse the server's own type rather than a parallel one, and keep it
// out of server/routes/hub.ts's import graph (that file must never import from
// scripts/**, which tsconfig.server.json does not include).
export type ScopeSuggestion = MemoryScopePatterns;

/** Validates a parsed model reply into a scope suggestion, or throws. */
export function validateSuggestion(value: unknown): ScopeSuggestion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('reply is not a JSON object');
  }
  const out: Record<string, string[]> = {};
  for (const tier of ['living', 'historical', 'excluded'] as const) {
    const list = (value as Record<string, unknown>)[tier];
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string' && v.trim())) {
      throw new Error(`${tier}: expected an array of non-empty strings`);
    }
    if (list.length > 64) throw new Error(`${tier}: implausibly long (${list.length} patterns)`);
    const cleaned = list.map((v) => v.trim().replace(/\/+$/, ''));
    for (const p of cleaned) {
      if (p.startsWith('/') || p.includes('..')) {
        throw new Error(`${tier}: "${p}" is not a hub-relative pattern`);
      }
    }
    out[tier] = cleaned;
  }
  return out as unknown as ScopeSuggestion;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const dryRun = argv.includes('--dry-run');
  const hub = resolveHub();
  const prompt = buildPrompt(hubStructure(hub.root));
  const claude = findClaude();
  // No tools at all: the structure is already in the prompt, and the run must
  // not read hub contents.
  const args = ['-p', prompt, '--allowedTools', ''];

  if (dryRun) {
    console.log(`[dry-run] ${claude ?? 'claude (NOT FOUND)'} ${JSON.stringify(args)}`);
    return 0;
  }
  if (!hub.root) {
    console.error('no hub connected; nothing to suggest a scope for');
    return 1;
  }
  if (!claude) {
    console.error('no claude binary found (set CHRONICLE_CLAUDE_BIN or put claude on PATH)');
    return 1;
  }

  // Dedicated runner cwd (never a real project dir), same seam as run-briefing.ts.
  const runnerDir = ensureDir('runner');
  const run = spawnSync(claude, args, {
    cwd: runnerDir,
    encoding: 'utf-8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CHRONICLE_DATA_DIR: DATA_DIR },
  });
  if (run.error || run.status !== 0) {
    console.error(`claude exited ${run.status ?? 'signal'}: ${(run.stderr || run.error?.message || '').trim().slice(0, 400)}`);
    return 1;
  }
  try {
    const suggestion = validateSuggestion(extractJson(run.stdout));
    console.log(JSON.stringify(suggestion, null, 2));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) process.exit(main());
