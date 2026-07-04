import React, { useEffect, useState } from 'react';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

export default function SecurityPage() {
  const [tab, setTab] = useState('interceptions');
  const [interceptions, setInterceptions] = useState([]);
  const [shares, setShares] = useState([]);
  const [hookResult, setHookResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (tab === 'interceptions') j('/api/security/interceptions').then(setInterceptions).catch((e) => setError(String(e.message)));
    if (tab === 'shares') j('/api/shares').then(setShares).catch((e) => setError(String(e.message)));
  }, [tab]);

  async function installHook() {
    try {
      const r = await j('/api/security/install-hook', { method: 'POST' });
      setHookResult(r);
    } catch (e) { setError(String(e.message)); }
  }

  return (
    <div className="page">
      <div className="project-head">
        <h2>🛡 Security</h2>
        <span className="pill warn-pill">real-time protection + safe sharing</span>
      </div>
      {error && <div className="error-banner" onClick={() => setError(null)}>{error}</div>}
      <div className="filter-chips" style={{ margin: '10px 0' }}>
        {[['interceptions', 'Interception records'], ['shares', 'Share management'], ['hook', 'Real-time protection setup']].map(([k, label]) => (
          <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'interceptions' && (
        <div>
          <p className="muted small">Every time the pre-tool-use guard finds sensitive content, it's recorded here —
            use these to tune your rules. Rules are managed per-session via 🛡 Security Check.</p>
          {!interceptions.length && <div className="muted center pad8">No interceptions yet. Install the hook (see Real-time protection setup) and they'll appear here.</div>}
          {interceptions.map((i) => (
            <div key={i.id} className="scan-row">
              <span className={`pill ${i.action === 'blocked' ? 'warn-pill' : ''}`}>{i.action}</span>
              <div className="scan-info">
                <div>{i.tool_name} {i.file_path && <span className="muted small">{i.file_path}</span>}</div>
                <div className="muted small">{JSON.parse(i.rules || '[]').join(', ')} · <code>{i.sample}</code></div>
              </div>
              <span className="muted small">{i.ts}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'shares' && (
        <div>
          <p className="muted small">Share links serve a redacted copy frozen at creation time — originals never leave
            this machine, and revoking a link is immediate. Create links from a session's 🛡 Security Check.</p>
          {!shares.length && <div className="muted center pad8">No share links yet.</div>}
          {shares.map((s) => (
            <div key={s.id} className="scan-row">
              <span className={`pill ${s.expired ? '' : 'ok-pill'}`}>{s.expired ? 'expired' : 'active'}</span>
              <div className="scan-info">
                <div><a href={`/share/${s.token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{s.title}</a></div>
                <div className="muted small">created {s.created_at} · expires {s.expires_at?.slice(0, 10)} · {s.views} views</div>
              </div>
              <button className="btn tiny ghost" onClick={async () => setShares(await j(`/api/shares/${s.id}`, { method: 'DELETE' }))}>Revoke</button>
            </div>
          ))}
        </div>
      )}

      {tab === 'hook' && (
        <div className="card" style={{ maxWidth: 760 }}>
          <h4>Pre-tool-use protection for Claude Code</h4>
          <p className="muted small">
            Installs a <code>PreToolUse</code> hook into <code>~/.claude/settings.json</code> (backed up first to
            <code> ~/.chronicle/backups/hooks/</code>). Before Claude Code runs Read / Grep / Bash / WebFetch, the hook
            asks Chronicle's security engine to scan the tool content. High-risk secrets (API keys, passwords, tokens,
            DB credentials) <b>block the call</b> with an explanation; lower-risk matches are flagged and logged here.
            If Chronicle isn't running, the hook fails open — your sessions are never broken.
          </p>
          <button className="btn primary" onClick={installHook}>Install hook into ~/.claude/settings.json</button>
          {hookResult && (
            <div className="card" style={{ marginTop: 10 }}>
              {hookResult.installed
                ? <>✓ Installed. Hook command: <code>{hookResult.command}</code><br />
                    <span className="muted small">Restart Claude Code sessions to activate. Settings backed up.</span></>
                : <>Already installed at <code>{hookResult.settingsPath}</code>.</>}
            </div>
          )}
          <p className="muted small" style={{ marginTop: 10 }}>
            Other tools: point any agent that supports command hooks at
            <code> node chronicle/hooks/chronicle-guard.mjs</code> (reads the tool payload on stdin, exit 2 = block).
          </p>
        </div>
      )}
    </div>
  );
}
