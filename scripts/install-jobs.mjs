#!/usr/bin/env node
// Install Chronicle's launchd job templates (CHI-323 3c). NOT run automatically:
// the templates ship DORMANT so a second daily briefing never fires alongside
// another console's. Run this by hand to opt in. macOS only.
//
// Usage: node scripts/install-jobs.mjs [--bootstrap]
//   fills each launchd/*.plist.template's __NODE__ / __REPO__ / __DATA__ and
//   writes it to ~/Library/LaunchAgents/. With --bootstrap it also loads the job
//   (launchctl bootstrap); without, it only installs the plist so you can review
//   it first and pause/resume it from the Jobs page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('Chronicle jobs are launchd-based (macOS only).');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const templatesDir = path.join(repoRoot, 'launchd');
const bootstrap = process.argv.includes('--bootstrap');

fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

// A job that needs secrets before it can stay up declares them in its own
// template (issue #186):
//
//   <!-- install-jobs: requires-env FOO BAR; env-file litellm/.env -->
//
// A KeepAlive job whose program exits for want of a key would otherwise respawn
// forever, which is what a fresh clone hits by default. We install the plist
// either way, so it stays reviewable and resumable from the Jobs page, and only
// withhold the bootstrap. Nothing here knows any particular job's name.
function parseRequirements(template) {
  const m = template.match(/install-jobs:\s*([^\n>]*)/);
  if (!m) return null;
  const env = (m[1].match(/requires-env\s+([^;]+)/) || [])[1];
  if (!env) return null;
  const file = (m[1].match(/env-file\s+([^;\s]+)/) || [])[1];
  return { keys: env.trim().split(/\s+/), envFile: file ? file.trim() : null };
}

/** Read `KEY=value` pairs from a dotenv-ish file. Values are not unquoted or
 *  expanded: we only need to know whether a key carries something. */
function envFileKeys(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Set(); }
  const set = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    // Strip surrounding quotes before deciding a value is empty, so KEY="" is
    // as unconfigured as KEY= is. This is the difference between "copied the
    // example" and "filled it in".
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value) set.add(m[1]);
  }
  return set;
}

/**
 * What the JOB will be missing, judged from what the JOB can see.
 *
 * A launchd agent does not inherit the installing shell's environment, so a key
 * exported in this terminal is NOT a key the job has: counting it would bootstrap
 * a job that then dies on exit 78 anyway. Only the declared env file counts.
 * Returns { missing, shellOnly }; both empty when the job declares no needs.
 */
function missingEnv(template) {
  const req = parseRequirements(template);
  if (!req || !req.envFile) return { missing: [], shellOnly: [] };
  const fromFile = envFileKeys(envFileFor(req));
  const missing = req.keys.filter((k) => !fromFile.has(k));
  // Named separately so the message can say why an exported key did not count.
  const shellOnly = missing.filter((k) => process.env[k]?.trim());
  return { missing, shellOnly };
}

/** Where to READ the declared env file. The job always reads the declared repo
 *  path (nothing sets LITELLM_ENV_FILE for it); the override exists so a test,
 *  or an operator who keeps the file elsewhere and symlinks it, can point the
 *  check at the real contents. */
function envFileFor(req) {
  const declared = path.resolve(repoRoot, req.envFile);
  const override = process.env.LITELLM_ENV_FILE?.trim();
  return override ? path.resolve(override) : declared;
}

const templates = fs.existsSync(templatesDir)
  ? fs.readdirSync(templatesDir).filter((f) => f.endsWith('.plist.template'))
  : [];
if (!templates.length) { console.log('No job templates found in launchd/.'); process.exit(0); }

for (const file of templates) {
  const label = file.replace(/\.plist\.template$/, '');
  const raw = fs.readFileSync(path.join(templatesDir, file), 'utf8');
  const filled = raw
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__REPO__', repoRoot)
    .replaceAll('__DATA__', dataDir);
  const dest = path.join(agentsDir, `${label}.plist`);
  fs.writeFileSync(dest, filled);
  console.log(`installed ${dest}`);
  const { missing, shellOnly } = bootstrap ? missingEnv(raw) : { missing: [], shellOnly: [] };
  if (missing.length) {
    console.log(
      `skipped bootstrap for ${label}: ${missing.join(', ')} not set yet. Fill them in ` +
      `(see the template's own note), then re-run with --bootstrap. Bootstrapping now ` +
      `would leave a KeepAlive job restart-looping.`,
    );
    if (shellOnly.length) {
      console.log(
        `  note: ${shellOnly.join(', ')} is exported in this shell, but a launchd job ` +
        `does not inherit it. It has to be in the env file to reach the job.`,
      );
    }
  } else if (bootstrap) {
    const r = spawnSync('launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, dest], { encoding: 'utf-8' });
    console.log(r.status === 0 ? `bootstrapped ${label}` : `bootstrap failed for ${label}: ${(r.stderr || '').trim()}`);
  }
}
console.log(bootstrap ? 'done.' : 'done (plists installed, not loaded — bootstrap with --bootstrap, or pause/resume from the Jobs page).');
