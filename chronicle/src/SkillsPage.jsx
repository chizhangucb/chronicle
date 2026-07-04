import React, { useEffect, useMemo, useState } from 'react';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const LINK_ICON = { linked: '🔗', 'real-dir': '📁', 'other-link': '⚠️', none: '·' };

export default function SkillsPage() {
  const [skills, setSkills] = useState([]);
  const [scan, setScan] = useState(null);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('library'); // library | import
  const [busy, setBusy] = useState(false);

  const refresh = () => j('/api/skills').then(setSkills).catch((e) => setError(String(e.message)));
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (tab === 'import' && !scan) j('/api/skills/scan').then(setScan).catch((e) => setError(String(e.message)));
  }, [tab]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => `${s.name} ${s.description} ${s.tags}`.toLowerCase().includes(q));
  }, [skills, query]);

  async function importAll(group) {
    setBusy(true);
    try {
      for (const item of group.items.filter((i) => i.status === 'importable')) {
        await post('/api/skills/import', { path: item.path, origin: group.source });
      }
      setScan(null); setTab('library'); refresh();
    } catch (e) { setError(String(e.message)); }
    finally { setBusy(false); }
  }

  async function setRating(s, rating) {
    setSkills(await j(`/api/skills/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating }) }));
  }

  return (
    <div className="page">
      <div className="project-head">
        <h2>✦ Skills Hub</h2>
        <span className="pill">{skills.length} managed skills</span>
        <span className="pill git-pill">central: ~/.chronicle/skills</span>
      </div>
      <p className="muted small">Import once, use everywhere: skills are stored centrally and distributed to each
        tool via symlinks. Distribution never overwrites a tool's existing skill directories.</p>
      {error && <div className="error-banner" onClick={() => setError(null)}>{error}</div>}

      <div className="filter-chips" style={{ margin: '10px 0' }}>
        <button className={`chip ${tab === 'library' ? 'on' : ''}`} onClick={() => setTab('library')}>Library</button>
        <button className={`chip ${tab === 'import' ? 'on' : ''}`} onClick={() => setTab('import')}>Scan & import</button>
        {tab === 'library' && (
          <input className="search" placeholder="Search skills…" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
      </div>

      {tab === 'library' && (
        <div className="project-grid">
          {shown.map((s) => (
            <div key={s.id} className="card project-card" onClick={() => j(`/api/skills/${s.id}`).then(setDetail)}>
              <div className="project-card-head">
                <span className="project-name">{s.name}</span>
                <Stars value={s.rating} onSet={(r) => setRating(s, r)} />
              </div>
              <div className="muted small" style={{ minHeight: 34, overflow: 'hidden' }}>{s.description || '(no description)'}</div>
              <div className="project-stats" style={{ marginTop: 8 }}>
                {s.links.map((l) => (
                  <span key={l.tool} className={`pill ${l.status === 'linked' ? 'ok-pill' : ''}`}
                    title={`${l.tool}: ${l.status}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        if (l.status === 'linked') setSkills(await post(`/api/skills/${s.id}/unlink`, { tool: l.tool }));
                        else if (l.status === 'none') setSkills(await post(`/api/skills/${s.id}/link`, { tool: l.tool }));
                      } catch (err) { setError(String(err.message)); }
                    }}>
                    {LINK_ICON[l.status]} {l.tool}
                  </span>
                ))}
              </div>
              <div className="muted small">from {s.origin_source || '?'}</div>
            </div>
          ))}
          {!shown.length && <div className="muted center pad8">No skills yet — use "Scan & import".</div>}
        </div>
      )}

      {tab === 'import' && (
        <div>
          <GithubImport onDone={() => { setTab('library'); refresh(); }} />
          {!scan && <div className="muted pad8">Scanning tool directories…</div>}
          {scan?.map((g) => (
            <div key={g.source} className="scan-group">
              <div className="scan-group-head">
                <strong>{g.source}</strong> <span className="muted small">{g.dir}</span>{' '}
                <button className="btn small" disabled={busy || !g.items.some((i) => i.status === 'importable')}
                  onClick={() => importAll(g)}>
                  {busy ? 'Importing…' : `Import ${g.items.filter((i) => i.status === 'importable').length} skills`}
                </button>
              </div>
              {g.items.map((i) => (
                <div key={i.path} className="scan-row">
                  <span className={`pill ${i.status === 'importable' ? 'ok-pill' : i.status === 'broken' ? 'warn-pill' : ''}`}>{i.status}</span>
                  <div className="scan-info">
                    <div>{i.name || i.dirName}</div>
                    <div className="muted small">{i.description?.slice(0, 110) || i.reason || i.path}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {scan && !scan.length && <div className="muted center pad8">No skill directories found on this machine.</div>}
        </div>
      )}

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>✦ {detail.name}</h3>
              <button className="btn ghost" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="muted small">{detail.central_path} · imported {detail.imported_at} · from {detail.origin_path}</div>
            <div className="muted small">files: {detail.files.join(', ')}</div>
            {detail.origin_repo && <UpstreamCheck skill={detail} />}
            <VersionTimeline skillId={detail.id} onRestored={() => j(`/api/skills/${detail.id}`).then(setDetail)} />
            <pre className="sec-text" style={{ maxHeight: 420, marginTop: 10 }}>{detail.content || '(no SKILL.md)'}</pre>
            <button className="btn small" style={{ marginTop: 8 }} onClick={async () => {
              if (confirm(`Remove '${detail.name}' from Chronicle (files kept)?`)) {
                setSkills(await j(`/api/skills/${detail.id}`, { method: 'DELETE' }));
                setDetail(null);
              }
            }}>Remove from hub</button>
          </div>
        </div>
      )}
    </div>
  );
}

function GithubImport({ onDone }) {
  const [form, setForm] = useState({ url: '', branch: 'main', subpath: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  async function run(e) {
    e.preventDefault();
    setBusy(true); setResult(null);
    try {
      const r = await j('/api/skills/github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      setResult(`✓ Imported ${r.imported.length} skills @ ${r.sha}`);
      setTimeout(onDone, 1200);
    } catch (err) { setResult('✕ ' + err.message); }
    finally { setBusy(false); }
  }
  return (
    <form className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }} onSubmit={run}>
      <strong>⬇ GitHub</strong>
      <input className="search" style={{ flex: 2, minWidth: 240 }} placeholder="https://github.com/org/repo (public)"
        value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
      <input className="search" style={{ width: 90 }} placeholder="branch" value={form.branch}
        onChange={(e) => setForm({ ...form, branch: e.target.value })} />
      <input className="search" style={{ width: 130 }} placeholder="subpath (optional)" value={form.subpath}
        onChange={(e) => setForm({ ...form, subpath: e.target.value })} />
      <button className="btn primary small" disabled={busy || !form.url}>{busy ? 'Cloning…' : 'Import'}</button>
      {result && <span className="small">{result}</span>}
    </form>
  );
}

function UpstreamCheck({ skill }) {
  const [status, setStatus] = useState(null);
  return (
    <div style={{ margin: '6px 0' }}>
      <span className="pill">⬇ {skill.origin_repo} @ {skill.origin_sha?.slice(0, 10)}</span>{' '}
      <button className="btn tiny ghost" onClick={async () => {
        try { const r = await j(`/api/skills/${skill.id}/check-upstream`, { method: 'POST' }); setStatus(r.upToDate ? '✓ up to date' : `↑ upstream at ${r.latest} — re-import to sync`); }
        catch (e) { setStatus('✕ ' + e.message); }
      }}>Check upstream</button>
      {status && <span className="small muted"> {status}</span>}
    </div>
  );
}

function VersionTimeline({ skillId, onRestored }) {
  const [snaps, setSnaps] = useState(null);
  useEffect(() => { j(`/api/skills/${skillId}/snapshots`).then(setSnaps).catch(() => setSnaps([])); }, [skillId]);
  if (!snaps?.length) return null;
  return (
    <div style={{ margin: '8px 0' }}>
      <div className="small muted">Version history ({snaps.length} snapshots)</div>
      {snaps.slice(0, 8).map((s) => (
        <div key={s.id} className="scan-row" style={{ padding: '4px 0' }}>
          <span className={`pill ${s.trigger === 'imported' ? 'ok-pill' : ''}`}>{s.trigger}</span>
          <span className="small muted">{s.ts} · {s.hash.slice(0, 8)} · {(s.size / 1024).toFixed(1)} KB</span>
          <span style={{ flex: 1 }} />
          <button className="btn tiny ghost" onClick={async () => {
            if (!confirm('Restore this version? Current state is snapshotted first.')) return;
            await j(`/api/skills/${skillId}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId: s.id }) });
            j(`/api/skills/${skillId}/snapshots`).then(setSnaps);
            onRestored();
          }}>Restore</button>
        </div>
      ))}
    </div>
  );
}

function Stars({ value, onSet }) {
  return (
    <span onClick={(e) => e.stopPropagation()} title="Rating (stored locally)">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} style={{ cursor: 'pointer', color: n <= value ? '#e5a54b' : 'var(--border)' }}
          onClick={() => onSet(n === value ? 0 : n)}>★</span>
      ))}
    </span>
  );
}
