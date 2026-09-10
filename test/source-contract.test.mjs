// The `Source` contract (#309): import, autosync and live consume the interface
// and never branch on the source string, and the old per-parser entry points
// are gone.
//
// Adding a fifth coding tool is meant to be one parser file plus one line in
// the registry (ADR 0004). That only holds if no caller names a source in code:
// the moment one does, the fifth tool needs an edit there too. So this reads
// the three callers as text and asserts what they may not contain, the way
// test/shared-engine-single-home.test.mjs and test/query-context-single-home.
// test.mjs pin their consolidations.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The three callers the ticket names.
const CALLERS = {
  import: 'server/routes/import-sync.ts',
  autosync: 'server/autosync.ts',
  live: 'server/live.ts',
};

// Comments are prose: they may (and should) name a source to explain it. Only
// code is under the no-branching rule.
function code(file) {
  return fs.readFileSync(path.join(REPO, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

const SOURCE_IDS = ['claude-code', 'codex', 'cursor', 'opencode', 'gemini', 'copilot'];

describe('import, autosync and live consume the Source interface', () => {
  for (const [name, file] of Object.entries(CALLERS)) {
    test(`${name} names no source in code`, () => {
      const text = code(file);
      for (const id of SOURCE_IDS) {
        assert.ok(!text.includes(`'${id}'`) && !text.includes(`"${id}"`),
          `${file} still names the source '${id}' — a fifth coding tool would need an edit here`);
      }
    });

    test(`${name} imports parsers only through the registry`, () => {
      const imports = [...code(file).matchAll(/from '([^']*parsers\/[^']+)'/g)].map((m) => m[1]);
      assert.ok(imports.length, `${file} imports nothing from parsers/ — expected the registry`);
      for (const spec of imports) {
        assert.ok(/parsers\/(registry|source)\.ts$/.test(spec),
          `${file} imports ${spec}; only parsers/registry.ts and parsers/source.ts are the seam`);
      }
    });
  }
});

describe('the old per-parser entry points are deleted', () => {
  const GONE = {
    'server/parsers/claudeCode.ts': ['scanClaudeProjects', 'parseClaudeSession', 'parseClaudeLine', 'claudeSessionMtimeMs', 'CLAUDE_PROJECTS_DIR'],
    'server/parsers/codex.ts': ['scanCodexProjects', 'parseCodexSession', 'CODEX_SESSIONS_DIR'],
    'server/parsers/cursor.ts': ['scanCursorProjects', 'parseCursorWorkspace', 'parseCursorAgentSessions', 'parseAgentTranscriptJsonl'],
    'server/parsers/opencode.ts': ['scanOpencodeProjects', 'parseOpencodeSessions', 'OPENCODE_DB'],
  };

  for (const [file, names] of Object.entries(GONE)) {
    test(`${path.basename(file)} exports its Source, not its internals`, async () => {
      const mod = await import(path.join(REPO, file));
      for (const name of names) {
        assert.equal(mod[name], undefined,
          `${file} still exports ${name}; the Source interface is the only way in`);
      }
      const source = Object.values(mod).find((v) => v && typeof v === 'object' && typeof v.parse === 'function');
      assert.ok(source, `${file} exports no Source`);
    });
  }
});
