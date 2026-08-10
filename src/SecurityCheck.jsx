import React, { useEffect, useState } from 'react';

// One-Click Security Check (FR-SEC-4): preview detections highlighted next to
// redacted output; manage custom rules; export a one-way redacted copy.
export default function SecurityCheck({ sessionId, projectName, onClose }) {
  const [scan, setScan] = useState(null);
  const [rules, setRules] = useState([]);
  const [error, setError] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [form, setForm] = useState({ pattern: '', replacement: '****', kind: 'redact' });

  async function refresh() {
    try {
      const [s, r] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(sessionId)}/security-check`).then((x) => x.json()),
        fetch('/api/security/rules').then((x) => x.json()),
      ]);
      if (s.error) throw new Error(s.error);
      setScan(s); setRules(r);
    } catch (e) { setError(String(e.message)); }
  }
  useEffect(() => { refresh(); }, [sessionId]);

  async function submitRule(e) {
    e.preventDefault();
    if (!form.pattern.trim()) return;
    await fetch('/api/security/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, name: form.pattern }),
    });
    setForm({ pattern: '', replacement: '****', kind: 'redact' });
    refresh();
  }
  async function removeRule(id) {
    await fetch(`/api/security/rules/${id}`, { method: 'DELETE' });
    refresh();
  }
  async function toggle(rule) {
    await fetch(`/api/security/rules/${rule.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    refresh();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>🛡 Security Check — {projectName}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {!scan && !error && <div className="muted center pad8">Scanning session for sensitive content…</div>}
        {scan && (
          <>
            <div className="sec-summary">
              {scan.findingCount === 0
                ? <span className="pill ok-pill">✓ No sensitive content detected — safe to share</span>
                : <>
                    <span className="pill warn-pill">{scan.findingCount} findings in {scan.messages.length} messages</span>
                    {Object.entries(scan.totals).map(([name, n]) => (
                      <span key={name} className="pill">{name}: {n}</span>
                    ))}
                  </>}
              <span style={{ flex: 1 }} />
              <button className="btn small" onClick={() => setShowRules(!showRules)}>
                {showRules ? 'Hide rules' : `Rules (${rules.length} custom)`}
              </button>
              <a className="btn small primary" href={`/api/sessions/${encodeURIComponent(sessionId)}/export-redacted`}
                download>Export redacted copy</a>
            </div>

            {showRules && (
              <div className="sec-rules card">
                <div className="small muted">Custom rules use glob patterns — <code>*</code> any length, <code>?</code> one char
                  (e.g. <code>PROJECT-*</code>, <code>*@company.com</code>). "Allow" rules protect matches from redaction.
                  Custom rules take priority over built-ins.</div>
                <form className="sec-rule-form" onSubmit={submitRule}>
                  <input className="search" placeholder="Pattern, e.g. KITE-*" value={form.pattern}
                    onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
                  <input className="search" placeholder="Replacement" value={form.replacement}
                    onChange={(e) => setForm({ ...form, replacement: e.target.value })} />
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                    <option value="redact">Redact</option>
                    <option value="allow">Allow (keep)</option>
                  </select>
                  <button className="btn small" type="submit">Add</button>
                </form>
                {rules.map((r) => (
                  <div key={r.id} className="sec-rule-row">
                    <code>{r.pattern}</code>
                    <span className="muted small">→ {r.kind === 'allow' ? '(kept)' : r.replacement}</span>
                    <span className={`pill ${r.kind === 'allow' ? 'ok-pill' : ''}`}>{r.kind}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn tiny ghost" onClick={() => toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</button>
                    <button className="btn tiny ghost" onClick={() => removeRule(r.id)}>Delete</button>
                  </div>
                ))}
                {!rules.length && <div className="muted small pad8">No custom rules yet.</div>}
              </div>
            )}

            <div className="sec-findings">
              {scan.messages.map((m) => (
                <div key={m.seq} className="sec-finding card">
                  <div className="muted small">#{m.seq} · {m.kind}{m.tool_name ? ` · ${m.tool_name}` : ''} · {m.findings.length} finding{m.findings.length > 1 ? 's' : ''}</div>
                  <div className="sec-cols">
                    <div>
                      <div className="sec-col-title">Detected</div>
                      <pre className="sec-text">{highlightFindings(m.originalText, m.originalInput, m.findings)}</pre>
                    </div>
                    <div>
                      <div className="sec-col-title ok">Redacted output</div>
                      <pre className="sec-text">{clip(m.redactedInput)}{m.redactedInput && m.redactedText ? '\n' : ''}{clip(m.redactedText)}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const CLIP = 700;

function clip(s) {
  if (!s) return '';
  return s.length > CLIP ? s.slice(0, CLIP) + ' …' : s;
}

// Render original text with <mark> around each finding (per field, clipped around first finding)
function highlightFindings(text, input, findings) {
  const out = [];
  for (const [field, value] of [['tool_input', input], ['text', text]]) {
    if (!value) continue;
    const fs = findings.filter((f) => f.field === field).sort((a, b) => a.start - b.start);
    if (!fs.length) { out.push(clip(value)); continue; }
    // Clip window starts a bit before the first finding
    const windowStart = Math.max(0, fs[0].start - 200);
    let cursor = windowStart;
    if (windowStart > 0) out.push('… ');
    for (const f of fs) {
      if (f.start < cursor) continue;
      if (f.start - windowStart > CLIP) break;
      out.push(value.slice(cursor, f.start));
      out.push(<mark key={`${field}${f.start}`} className="danger">{f.match}</mark>);
      cursor = f.end;
    }
    out.push(value.slice(cursor, windowStart + CLIP));
    if (value.length > windowStart + CLIP) out.push(' …');
    out.push('\n');
  }
  return out;
}
