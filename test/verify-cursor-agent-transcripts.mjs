#!/usr/bin/env node
/**
 * Validates Cursor agent-transcript discovery against fixture + optional real agent_deck data.
 * Usage:
 *   node test/verify-cursor-agent-transcripts.mjs
 *   node test/verify-cursor-agent-transcripts.mjs --real
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanCursorProjects,
  parseCursorWorkspace,
  parseAgentTranscriptJsonl,
  parseCursorAgentSessions,
} from '../server/parsers/cursor.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/cursor-user', import.meta.url));
const projectPath = '/Users/chizhang/health-analyst';

function buildFixture() {
  spawnSync('node', ['test/make-cursor-fixture.mjs'], { stdio: 'inherit' });
}

function runFixtureChecks() {
  process.env.CHRONICLE_CURSOR_DIR = fixtureRoot;
  process.env.CHRONICLE_CURSOR_PROJECTS_DIR = path.join(fixtureRoot, 'projects');

  const scanned = scanCursorProjects(fixtureRoot);
  const row = scanned.find((s) => s.physicalPath === projectPath);
  if (!row) throw new Error('fixture scan missing health-analyst project');

  const parsed = parseCursorWorkspace(row.logDir, fixtureRoot, projectPath);
  const ids = parsed.map((p) => p.session.id).sort();
  const expected = ['cursor-chat-tab1', 'cursor-composer-agent-session-1', 'cursor-composer-comp1'];
  for (const id of expected) {
    if (!ids.includes(id)) throw new Error(`fixture parse missing ${id}; got ${ids.join(', ')}`);
  }

  const agent = parsed.find((p) => p.session.id === 'cursor-composer-agent-session-1');
  if (!agent?.events.some((e) => e.kind === 'user' && e.text.includes('agent transcript import'))) {
    throw new Error('fixture agent transcript did not parse user prompt');
  }

  const transcriptFile = path.join(fixtureRoot, 'projects', 'Users-chizhang-health-analyst', 'agent-transcripts', 'agent-session-1', 'agent-session-1.jsonl');
  const direct = parseAgentTranscriptJsonl(transcriptFile);
  if (direct.length < 2) throw new Error('direct transcript parse too short');

  console.log('fixture ok', { scannedSessions: row.sessionCount, parsedSessions: parsed.length });
}

function runRealCheck() {
  delete process.env.CHRONICLE_CURSOR_DIR;
  delete process.env.CHRONICLE_CURSOR_PROJECTS_DIR;
  const agentDeck = '/Users/not_so_fat/workspace/codes/agent_deck';
  const parsed = parseCursorAgentSessions(agentDeck);
  console.log('agent_deck ok', {
    parsedAgentSessions: parsed.length,
    sampleTitles: parsed.slice(0, 3).map((p) => p.session.first_prompt?.slice(0, 60)),
  });
  if (parsed.length < 20) {
    throw new Error(`expected at least 20 parsed agent_deck sessions, got ${parsed.length}`);
  }
}

buildFixture();
runFixtureChecks();
if (process.argv.includes('--real')) runRealCheck();
