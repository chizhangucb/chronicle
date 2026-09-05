// Pins the Jobs slices + log tail + adapter + routes (CHI-323 3c). The jobs
// collector is pure over injected launchctl/crontab, so this drives it with no
// real machine state. CHRONICLE_DATA_DIR is a temp dir BEFORE import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-jobs-data-'));
process.env.CHRONICLE_DATA_DIR = data;

function makeHub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-jobs-hub-'));
  fs.mkdirSync(path.join(root, 'records'));
  fs.mkdirSync(path.join(root, 'governance'));
  fs.writeFileSync(path.join(root, 'operations.md'), [
    '# ops', '', '## Scheduled tasks', '',
    '| Job | Schedule | Max staleness | Runner | Last run | What it does |',
    '|---|---|---|---|---|---|',
    '| health-sweep | every 6h | 8h | claude | (auto) | Probe hub health |',
    '',
  ].join('\n'));
  // a heartbeat that is stale (old ended_at)
  fs.mkdirSync(path.join(root, '.tmp', 'heartbeats'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tmp', 'heartbeats', 'health-sweep.json'),
    JSON.stringify({ job_id: 'health-sweep', started_at: '2020-01-01T00:00:00Z', ended_at: '2020-01-01T00:00:05Z', exit_code: 0, runner: 'claude' }));
  return root;
}
const hub = makeHub();

const jobs = await import('../server/hub/slices/jobs.ts');
const auto = await import('../server/hub/slices/automations.ts');
const { jobLogView, readLogTail } = await import('../server/job-logs.ts');
const { getHubAdapter } = await import('../server/hub/adapter.ts');
const { mountHub } = await import('../server/routes/hub.ts');

test('attributeCommand: wrapper-aware, --model long form only', () => {
  assert.deepEqual(jobs.attributeCommand(['python3', 'run.py', 'x', '--', 'claude', '--model', 'opus']),
    { runner: 'claude', model: 'opus', agent: 'claude' });
  assert.equal(jobs.attributeCommand(['python3', '-m', 'foo']).model, null); // -m is not a model flag
});

test('schedule describers + next-run are deterministic', () => {
  assert.equal(jobs.describeCalendar([{ Hour: 9, Minute: 0 }]), 'daily 09:00');
  assert.equal(jobs.describeInterval(1800), 'every 30m');
  const now = new Date('2026-01-01T08:00:00');
  const next = jobs.nextCalendarRun([{ Hour: 9, Minute: 0 }], now);
  assert.equal(next.getHours(), 9);
});

test('parseCrontab + nextCronRun', () => {
  const entries = jobs.parseCrontab('# c\n0 3 * * * /bin/backup\n@daily /bin/x\nFOO=bar\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].command, '/bin/backup');
  const n = jobs.nextCronRun(['0', '3', '*', '*', '*'], new Date('2026-01-01T00:00:00'));
  assert.equal(n.getHours(), 3);
});

test('deriveLaunchdJob status: paused when launchctl does not know the label', () => {
  const plist = { Label: 'com.x', ProgramArguments: ['claude'], StartCalendarInterval: { Hour: 9 } };
  assert.equal(jobs.deriveLaunchdJob(plist, undefined, new Date()).status, 'paused'); // unloaded
  assert.equal(jobs.deriveLaunchdJob(plist, { pid: 123, lastExit: null }, new Date()).status, 'running');
  assert.equal(jobs.deriveLaunchdJob(plist, { pid: null, lastExit: 0 }, new Date()).status, 'success');
  assert.equal(jobs.deriveLaunchdJob(plist, { pid: null, lastExit: 1 }, new Date()).status, 'failed');
});

test('findMissingPath is conservative (absolute argv0 or script-ext only)', () => {
  assert.equal(jobs.findMissingPath(['/no/such/bin'], null, () => false), '/no/such/bin');
  assert.equal(jobs.findMissingPath(['claude', '--flag'], null, () => false), null); // PATH lookup not verifiable
});

test('collectJobs merges registry (heartbeat stale outranks a clean exit) + repo templates', () => {
  const launchctl = () => 'PID\tStatus\tLabel\n-\t0\tcom.chronicle.health-sweep\n';
  const registry = auto.collectAutomations(hub); // health-sweep -> stale (old heartbeat)
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-jobs-repo-'));
  fs.mkdirSync(path.join(repoRoot, 'launchd'));
  fs.writeFileSync(path.join(repoRoot, 'launchd', 'com.demo.thing.plist.template'), 'x');
  const slice = jobs.collectJobs({
    registry, repoRoot, agentsDir: '/no/such/agents', now: new Date(),
    runLaunchctl: launchctl, runCrontab: () => '',
  });
  // registry orphan present + stale from heartbeat
  const hs = slice.jobs.find((j) => j.name === 'health-sweep');
  assert.ok(hs);
  assert.equal(hs.status, 'stale');
  // dormant template shows as not-installed
  const tmpl = slice.jobs.find((j) => j.id === 'com.demo.thing');
  assert.equal(tmpl.status, 'not-installed');
  assert.equal(slice.sources['repo-template'], 1);
});

test('automations: staleness parse + derive (stale when overdue)', () => {
  assert.equal(auto.parseStalenessMs('8h'), 8 * 3600000);
  const row = auto.deriveAutomationRow(
    { name: 'j', schedule: 'every 6h', maxStaleness: '8h', runner: 'claude', lastRun: '', description: '', status: 'active' },
    { job_id: 'j', started_at: '2020-01-01T00:00:00Z', ended_at: '2020-01-01T00:00:00Z', exit_code: 0, runner: 'claude' },
    new Date('2026-01-01T00:00:00Z'),
  );
  assert.equal(row.status, 'stale');
});

test('job-logs: reads only the declared path; unknown id -> null; tail-caps', () => {
  const logFile = path.join(data, 'x.log');
  fs.writeFileSync(logFile, Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'));
  const tail = readLogTail(logFile);
  assert.equal(tail.exists, true);
  assert.equal(tail.lines.length, 100); // TAIL_LINES
  assert.equal(tail.truncated, true);
  const view = jobLogView([{ id: 'j1', logPath: logFile }], 'j1');
  assert.equal(view.stdout.exists, true);
  assert.equal(jobLogView([{ id: 'j1', logPath: logFile }], 'nope'), null);
});

test('adapter: demo jobs synthetic (no real scan); absent empty', () => {
  const demo = getHubAdapter({ CHRONICLE_DEMO: '1' }).jobs();
  assert.ok(demo.jobs.length >= 3);
  assert.ok(demo.jobs.find((j) => j.status === 'not-installed'));
  assert.equal(getHubAdapter({}).jobs().jobs.length, 0);
});

// ---- routes ----
let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  mountHub(app);
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => { if (server) await new Promise((r) => server.close(r)); delete process.env.CHRONICLE_DEMO; });

test('GET /hub/jobs: absent sentinel; demo returns synthetic', async () => {
  assert.deepEqual(await (await fetch(`${baseUrl}/hub/jobs`)).json(), { hubPresent: false });
  process.env.CHRONICLE_DEMO = '1';
  try {
    const body = await (await fetch(`${baseUrl}/hub/jobs`)).json();
    assert.ok(body.jobs.length >= 3);
  } finally { delete process.env.CHRONICLE_DEMO; }
});

test('GET /jobs/log in demo tails the declared demo log', async () => {
  process.env.CHRONICLE_DEMO = '1';
  try {
    const body = await (await fetch(`${baseUrl}/jobs/log?id=com.chronicle.daily-digest`)).json();
    assert.ok(body.stdout.exists);
    assert.ok(body.stdout.lines.some((l) => l.includes('daily-digest run')));
  } finally { delete process.env.CHRONICLE_DEMO; }
});
