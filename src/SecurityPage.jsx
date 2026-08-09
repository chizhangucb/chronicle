import React, { useEffect, useState } from 'react';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

// Security home: share-link management. Redaction rules + scans live in each
// session's 🛡 Security Check. (The pre-tool-use guard hook and its
// interception log were removed in v0.2.)
export default function SecurityPage() {
  const [shares, setShares] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    j('/api/shares').then(setShares).catch((e) => setError(String(e.message)));
  }, []);

  return (
    <div className="page">
      <div className="project-head">
        <h2>🛡 Security</h2>
        <span className="pill warn-pill">safe sharing</span>
      </div>
      {error && <div className="error-banner" onClick={() => setError(null)}>{error}</div>}
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
    </div>
  );
}
