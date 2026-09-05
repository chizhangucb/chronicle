#!/usr/bin/env node
// Install Chronicle's launchd job templates. Development tooling: the templates
// are tracked but NOT published in the npm tarball, and nothing runs this for
// you — a scheduled job never exists until you run this by hand. macOS only.
// Today the only template is the optional LiteLLM spine (see litellm/README.md).
//
// Usage: node scripts/install-jobs.mjs [--bootstrap]
//   fills each launchd/*.plist.template's __NODE__ / __REPO__ / __DATA__ and
//   writes it to ~/Library/LaunchAgents/. With --bootstrap it also loads the job
//   (launchctl bootstrap); without, it only installs the plist so you can review
//   it first and load it yourself with launchctl.
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
//   <!-- install-jobs: requires-env FOO BAR; env-file litellm/.env; env-file-var FOO_ENV -->
//
// `env-file` is the path the JOB reads by default. `env-file-var` names the
// variable that overrides it, and is what lets an operator keep the file
// outside the repo: when this installer resolves a different path, it writes
// that variable into the plist so the job reads the same file the readiness
// check just read. Without that the two disagree and we bootstrap a job that
// cannot start.
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
  const fileVar = (m[1].match(/env-file-var\s+([^;\s]+)/) || [])[1];
  return {
    keys: env.trim().split(/\s+/),
    envFile: file ? file.trim() : null,
    envFileVar: fileVar ? fileVar.trim() : null,
  };
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
  if (!req) return { missing: [], shellOnly: [] };
  // A template that names required keys but no file to read them from gives the
  // job no way to receive them, so every key counts as missing. Reporting
  // "nothing required" here would bootstrap it unchecked.
  const fromFile = req.envFile ? envFileKeys(envFileFor(req)) : new Set();
  const missing = req.keys.filter((k) => !fromFile.has(k));
  // Named separately so the message can say why an exported key did not count.
  const shellOnly = missing.filter((k) => process.env[k]?.trim());
  return { missing, shellOnly };
}

/** The env file BOTH sides use: this check, and the job once installed. The
 *  override is honoured only when the template names the variable that carries
 *  it, because that is what lets us write the path into the plist below. */
function envFileFor(req) {
  const declared = path.resolve(repoRoot, req.envFile);
  const override = req.envFileVar ? process.env[req.envFileVar]?.trim() : null;
  return override ? path.resolve(override) : declared;
}

const xmlEscape = (v) => v
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The plist lines that hand the job a non-default env-file path, so it reads
 *  what this installer checked. Empty when the job uses the declared default. */
function extraEnvFor(template) {
  const req = parseRequirements(template);
  if (!req?.envFile || !req.envFileVar) return '';
  const resolved = envFileFor(req);
  if (resolved === path.resolve(repoRoot, req.envFile)) return '';
  return `    <key>${xmlEscape(req.envFileVar)}</key>\n    <string>${xmlEscape(resolved)}</string>`;
}

const templates = fs.existsSync(templatesDir)
  ? fs.readdirSync(templatesDir).filter((f) => f.endsWith('.plist.template'))
  : [];
if (!templates.length) { console.log('No job templates found in launchd/.'); process.exit(0); }

for (const file of templates) {
  const label = file.replace(/\.plist\.template$/, '');
  const raw = fs.readFileSync(path.join(templatesDir, file), 'utf8');
  const extraEnv = extraEnvFor(raw);
  const filled = raw
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__REPO__', repoRoot)
    .replaceAll('__DATA__', dataDir)
    // Drop the whole line when there is nothing to add, so the plist keeps its
    // shape rather than growing a blank.
    .replace(/^\s*__EXTRA_ENV__\n/m, extraEnv ? `${extraEnv}\n` : '')
    .replaceAll('__EXTRA_ENV__', extraEnv);
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
