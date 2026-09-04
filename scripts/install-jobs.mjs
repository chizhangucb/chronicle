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

// The LiteLLM job needs keys before it can stay up: run.sh exits 78 when they
// are missing, and KeepAlive would turn that into a permanent respawn loop on a
// fresh clone (issue #186). Install the plist either way so it is reviewable and
// resumable from the Jobs page, but never bootstrap it unconfigured.
function litellmConfigured() {
  const envFile = process.env.LITELLM_ENV_FILE || path.join(repoRoot, 'litellm', '.env');
  if (fs.existsSync(envFile)) return true;
  return !!(process.env.OPENROUTER_API_KEY && process.env.LITELLM_MASTER_KEY);
}

const templates = fs.existsSync(templatesDir)
  ? fs.readdirSync(templatesDir).filter((f) => f.endsWith('.plist.template'))
  : [];
if (!templates.length) { console.log('No job templates found in launchd/.'); process.exit(0); }

for (const file of templates) {
  const label = file.replace(/\.plist\.template$/, '');
  const filled = fs.readFileSync(path.join(templatesDir, file), 'utf8')
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__REPO__', repoRoot)
    .replaceAll('__DATA__', dataDir);
  const dest = path.join(agentsDir, `${label}.plist`);
  fs.writeFileSync(dest, filled);
  console.log(`installed ${dest}`);
  if (bootstrap && label === 'com.chronicle.litellm' && !litellmConfigured()) {
    console.log(
      `skipped bootstrap for ${label}: no keys yet. Copy litellm/.env.example to ` +
      `litellm/.env, fill in OPENROUTER_API_KEY + LITELLM_MASTER_KEY, then re-run ` +
      `with --bootstrap (it would otherwise restart-loop on exit 78).`,
    );
  } else if (bootstrap) {
    const r = spawnSync('launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, dest], { encoding: 'utf-8' });
    console.log(r.status === 0 ? `bootstrapped ${label}` : `bootstrap failed for ${label}: ${(r.stderr || '').trim()}`);
  }
}
console.log(bootstrap ? 'done.' : 'done (plists installed, not loaded — bootstrap with --bootstrap, or pause/resume from the Jobs page).');
