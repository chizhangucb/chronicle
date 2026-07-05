#!/usr/bin/env node
// Chronicle pre-tool-use guard — Claude Code PreToolUse hook (FR-SEC-5).
// Reads the hook payload on stdin, asks Chronicle's security engine to scan the
// tool content, and blocks the call (exit 2) when high-risk secrets are found.
// Fails OPEN: if Chronicle isn't running, the tool call proceeds untouched.

const CHRONICLE = process.env.CHRONICLE_URL || 'http://localhost:4173';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

try {
  const res = await fetch(`${CHRONICLE}/api/security/pretooluse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool_name: payload.tool_name, tool_input: payload.tool_input }),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) process.exit(0);
  const verdict = await res.json();
  if (verdict.decision === 'block') {
    console.error(verdict.reason);
    process.exit(2); // exit 2 = block the tool call; stderr is shown to the model
  }
} catch {
  // Chronicle offline — never break the user's session
}
process.exit(0);
