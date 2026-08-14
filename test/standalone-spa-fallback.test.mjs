// Test for SPA fallback under dot-segment install paths (e.g. npx _npx/<hash>,
// .claude/worktrees/…). The bug: res.sendFile(path.join(dist, 'index.html'))
// triggers express/send's dotfiles: 'ignore' heuristic on the absolute path,
// causing 404s. The fix: res.sendFile('index.html', { root: dist }) checks dot
// segments relative to root only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTempDb } from './helpers.mjs';

let dbModule, dbTeardown, server, baseUrl;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  dbTeardown = temp.teardown;
});

after(async () => {
  // Importing server/standalone.ts (below) pulls in server/api.ts, which
  // calls startAutoSync() at module scope — that registers recursive
  // fs.watch() handles on the real source-log dirs (~/.claude/projects etc.)
  // plus a setInterval backstop. Neither is torn down by server.close(), so
  // without explicitly stopping them here this test process's event loop
  // never goes empty and `node --test` hangs forever after the assertions
  // already passed (caught live: verified via `sample` showing the process
  // idle in uv__io_poll/kevent with zero CPU, not actually still working).
  const { stopAutoSync } = await import('../server/autosync.ts');
  stopAutoSync();
  if (server) server.close();
  dbTeardown();
});

test('SPA fallback returns index.html for deep routes under dot-segment install paths', async () => {
  // Create a temp dir WITH a dot segment (like .claude/worktrees/...)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-spa-test-'));
  const dotDir = path.join(tmpDir, '.dotted', 'dist');
  fs.mkdirSync(dotDir, { recursive: true });

  const indexHtml = '<html><body>Test Index</body></html>';
  fs.writeFileSync(path.join(dotDir, 'index.html'), indexHtml);

  try {
    // Import startServer AFTER setting up the temp dist dir
    const { startServer } = await import('../server/standalone.ts');

    // Start server with the dot-segment dist path
    server = await startServer(0, dotDir);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Test 1: GET / should return index.html
    const resRoot = await fetch(`${baseUrl}/`);
    assert.equal(resRoot.status, 200, 'GET / should return 200');
    const bodyRoot = await resRoot.text();
    assert.equal(bodyRoot, indexHtml, 'GET / should return index.html body');

    // Test 2: GET /projects (deep SPA route) should also return index.html,
    // not 404. This is the bug scenario — without the fix, express/send's
    // dotfiles: 'ignore' would trigger on the absolute path's .dotted segment.
    const resProjects = await fetch(`${baseUrl}/projects`);
    assert.equal(resProjects.status, 200, 'GET /projects should return 200, not 404');
    const bodyProjects = await resProjects.text();
    assert.equal(bodyProjects, indexHtml, 'GET /projects should return index.html body');

    // Test 3: GET /session/123 (another deep route)
    const resSession = await fetch(`${baseUrl}/session/123`);
    assert.equal(resSession.status, 200, 'GET /session/:id should return 200');
    const bodySession = await resSession.text();
    assert.equal(bodySession, indexHtml, 'GET /session/:id should return index.html body');
  } finally {
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
