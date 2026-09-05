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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { demoSessions, DEMO_CORPUS_VERSION } from './corpus.ts';
import { writeDemoSession } from './transcripts.ts';

/** Marker written once a seed completes, so a half-finished seed (killed
 *  mid-import) is rebuilt rather than served as a truncated console. */
const DONE_MARKER = '.seed-complete';

function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The data directory a demo server should run against. Stable per day so the
 *  cache can be reused; under the OS temp dir so ~/.chronicle is untouched. */
export function demoDataDir(now = new Date()): string {
  return path.join(os.tmpdir(), `chronicle-demo-${DEMO_CORPUS_VERSION}-${todayKey(now)}`);
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
  return { seeded: imported, cached: false };
}

