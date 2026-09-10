// Demo seeding.
//
// `chronicle --demo` shows the WHOLE product on synthetic data, not just the
// synthetic slices CHRONICLE_DEMO already provided. The sessions go in
// through gatherParsed/importParsed, the same functions POST /api/import calls,
// so demo exercises the production parse and import path rather than a
// privileged shortcut that could drift from it.
//
// WHERE IT LANDS. Never ~/.chronicle: the demo database lives in a directory
// under the OS temp dir, and the caller points CHRONICLE_DATA_DIR at it before
// the server boots. The operator's real database is never opened, never
// migrated, and never written.
//
// THE CACHE KEY is (corpus version, today's local date). Two consequences,
// both wanted:
//   - Relaunching demo on the same day reuses the built database, so only the
//     first launch of the day pays the import cost.
//   - Crossing midnight rebuilds, so "today" in the demo is actually today.
//     A cached database would otherwise drift until the Today window was empty,
//     which is the exact failure that made committing dated transcripts wrong.
// A key that changes needs a sweeper, or every day demo is opened leaves ~7MB
// behind forever, so a finished seed prunes the caches it replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoSessions, DEMO_CORPUS_VERSION } from './corpus.ts';
import { writeDemoSession } from './transcripts.ts';

/** Marker written once a seed completes, so a half-finished seed (killed
 *  mid-import) is rebuilt rather than served as a truncated console. */
const DONE_MARKER = '.seed-complete';

/** The exact prefix every demo cache dir carries. Load-bearing: it is the only
 *  thing that tells a dead cache apart from a stranger's temp dir. */
const DIR_PREFIX = 'chronicle-demo-';

function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The data directory a demo server should run against. Stable per day so the
 *  cache can be reused; under the OS temp dir so ~/.chronicle is untouched. */
export function demoDataDir(now = new Date()): string {
  return path.join(os.tmpdir(), `${DIR_PREFIX}${DEMO_CORPUS_VERSION}-${todayKey(now)}`);
}

/**
 * Remove the demo caches `keep` has replaced: its siblings carrying the demo
 * prefix, one per earlier day or corpus version.
 *
 * This deletes trees the operator did not name, so it is deliberately timid:
 * it works only inside the OS temp dir, only on names starting with the exact
 * demo prefix, and only on real directories (a symlink is left where it lies
 * rather than followed to whatever it points at). Every removal that fails is
 * swallowed: a second demo still holding yesterday's dir open is a reason to
 * leave it alone, never a reason to fail the seed that just succeeded.
 *
 * Returns the directories actually removed.
 */
export function pruneStaleDemoDirs(keep: string): string[] {
  const kept = path.resolve(keep);
  const root = path.dirname(kept);
  const tmp = path.resolve(os.tmpdir());
  if (root !== tmp && !root.startsWith(tmp + path.sep)) return [];

  const removed: string[] = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    // withFileTypes does not follow links, so a symlink to a directory reports
    // isDirectory() false and is skipped here rather than deleted through.
    if (!entry.isDirectory() || !entry.name.startsWith(DIR_PREFIX)) continue;
    const dir = path.join(root, entry.name);
    if (dir === kept) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Locked, in use, or not ours to delete. Not the seed's problem.
    }
  }
  return removed;
}

export function demoIsSeeded(dir = demoDataDir()): boolean {
  return fs.existsSync(path.join(dir, DONE_MARKER));
}

/**
 * Build the demo database if today's is not already built.
 *
 * MUST be called with CHRONICLE_DATA_DIR already pointing at `dir`, because
 * server/db.ts binds its handle at import time: the dynamic imports below are
 * what make that ordering enforceable rather than merely documented.
 */
export async function seedDemo(dir = demoDataDir(), log: (msg: string) => void = () => {}): Promise<{ seeded: number; cached: boolean }> {
  if (demoIsSeeded(dir)) return { seeded: 0, cached: true };
  fs.mkdirSync(dir, { recursive: true });

  if (process.env.CHRONICLE_DATA_DIR !== dir) {
    throw new Error(`seedDemo: CHRONICLE_DATA_DIR must be ${dir} before seeding (db.ts binds at import time)`);
  }

  const specs = demoSessions();
  const fixtureDir = path.join(dir, 'transcripts');
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  const now = Date.now();
  const byProjectDir = new Map<string, string[]>();
  for (const spec of specs) {
    const file = writeDemoSession(fixtureDir, spec, now);
    const logDir = path.dirname(file);
    if (!byProjectDir.has(logDir)) byProjectDir.set(logDir, []);
    byProjectDir.get(logDir)!.push(file);
  }
  log(`generated ${specs.length} demo sessions across ${byProjectDir.size} projects`);

  // Imported through the production seam, not a direct DB write.
  const { gatherParsed, importParsed } = await import('../routes/import-sync.ts');
  let imported = 0;
  for (const [logDir, files] of byProjectDir) {
    const parsed = await gatherParsed({ source: 'claude-code', logDir, files });
    imported += importParsed(parsed).imported;
  }
  log(`imported ${imported} demo sessions`);

  fs.writeFileSync(path.join(dir, DONE_MARKER), new Date().toISOString());

  // Only now, with a complete database of its own, does the seed drop the
  // caches it superseded: earlier days and earlier corpus versions.
  const dropped = pruneStaleDemoDirs(dir);
  if (dropped.length) log(`removed ${dropped.length} stale demo cache${dropped.length === 1 ? '' : 's'}`);

  return { seeded: imported, cached: false };
}

