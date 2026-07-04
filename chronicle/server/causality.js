import path from 'node:path';
import { db } from './db.js';

// Context Causality (FR-CC): link the material the AI read (Reference Blocks)
// to the code changes it made, with a heuristic confidence score.
// Local-first: pure structural analysis, no LLM calls.

const READ_TOOLS = new Set(['Read', 'read_file', 'Grep', 'grep', 'Glob', 'glob', 'View', 'cat', 'NotebookRead']);
const CHANGE_TOOLS = new Set(['Write', 'Edit', 'write_file', 'edit_file', 'NotebookEdit']);

function extractPath(toolName, inputJson) {
  try {
    const input = JSON.parse(inputJson || '{}');
    return input.file_path || input.path || input.notebook_path || null;
  } catch { return null; }
}

function extractPattern(inputJson) {
  try {
    const input = JSON.parse(inputJson || '{}');
    return input.pattern || input.query || null;
  } catch { return null; }
}

export function analyzeCausality(sessionId) {
  const messages = db.prepare(
    `SELECT seq, ts, kind, tool_name, tool_input FROM messages
     WHERE session_id = ? AND kind = 'tool_use' ORDER BY seq`).all(sessionId);

  const reads = [];    // {seq, ts, file|pattern, tool}
  const changes = [];  // {seq, ts, file, tool, sources: []}

  for (const m of messages) {
    if (READ_TOOLS.has(m.tool_name)) {
      const file = extractPath(m.tool_name, m.tool_input);
      const pattern = extractPattern(m.tool_input);
      if (file || pattern) reads.push({ seq: m.seq, ts: m.ts, file, pattern, tool: m.tool_name });
    } else if (CHANGE_TOOLS.has(m.tool_name)) {
      const file = extractPath(m.tool_name, m.tool_input);
      if (file) changes.push({ seq: m.seq, ts: m.ts, file, tool: m.tool_name, sources: [] });
    }
  }

  for (const change of changes) {
    const priorReads = reads.filter((r) => r.seq < change.seq);
    const recentWindow = priorReads.slice(-8); // temporal proximity window
    const seen = new Set();
    for (const read of priorReads) {
      let confidence = 0;
      let reason = null;
      if (read.file && read.file === change.file) {
        confidence = 0.95; reason = 'read this exact file before changing it';
      } else if (read.file && path.dirname(read.file) === path.dirname(change.file)) {
        confidence = 0.55; reason = 'read a sibling file in the same directory';
      } else if (read.file && stem(read.file) === stem(change.file)) {
        confidence = 0.5; reason = 'read a file with the same base name';
      } else if (read.pattern && matchesPattern(change.file, read.pattern)) {
        confidence = 0.45; reason = `searched for “${read.pattern}”`;
      } else if (recentWindow.includes(read)) {
        confidence = 0.2; reason = 'read shortly before this change (background context)';
      }
      if (confidence > 0) {
        const key = `${read.seq}`;
        if (seen.has(key)) continue;
        seen.add(key);
        change.sources.push({ seq: read.seq, file: read.file, pattern: read.pattern, tool: read.tool, confidence, reason });
      }
    }
    change.sources.sort((a, b) => b.confidence - a.confidence);
    change.sources = change.sources.slice(0, 10);
  }

  // Mentioned files per message (FR-CC-1): quick lookup for header chips
  const mentioned = {};
  for (const r of reads) {
    if (r.file) (mentioned[r.seq] ??= []).push(r.file);
  }
  for (const c of changes) (mentioned[c.seq] ??= []).push(c.file);

  return { changes, readCount: reads.length, mentioned };
}

function stem(f) {
  return path.basename(f).replace(/\.[^.]+$/, '');
}

function matchesPattern(file, pattern) {
  try {
    const p = pattern.toLowerCase();
    const f = file.toLowerCase();
    return p.length > 2 && (f.includes(p) || stem(f).includes(p));
  } catch { return false; }
}
