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
  if (bootstrap) {
    const r = spawnSync('launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, dest], { encoding: 'utf-8' });
    console.log(r.status === 0 ? `bootstrapped ${label}` : `bootstrap failed for ${label}: ${(r.stderr || '').trim()}`);
  }
}
console.log(bootstrap ? 'done.' : 'done (plists installed, not loaded — bootstrap with --bootstrap, or pause/resume from the Jobs page).');
