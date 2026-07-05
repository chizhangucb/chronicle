import React, { useEffect, useState } from 'react';

async function j(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function HubPage() {
  const [services, setServices] = useState([]);
  const [status, setStatus] = useState(null);
  const [scan, setScan] = useState(null);
  const [tools, setTools] = useState(null);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('services'); // services | takeover | inspector
  const [invoke, setInvoke] = useState({ name: '', args: '{}' , result: null });
  const [policyFor, setPolicyFor] = useState(null); // service id with open tool-policy panel
  const [svcTools, setSvcTools] = useState({});     // service name -> [tool names]

  async function loadPolicyTools() {
    const t = await j('/api/mcp/tools');
    const grouped = {};
    for (const tool of t.tools) {
      const [svc, name] = tool.name.split('__');
      (grouped[svc] ??= []).push(name);
    }
    setSvcTools(grouped);
  }

  async function toggleTool(service, toolName) {
    const disabled = new Set(JSON.parse(service.disabled_tools || '[]'));
    disabled.has(toolName) ? disabled.delete(toolName) : disabled.add(toolName);
    setServices(await j(`/api/mcp/services/${service.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabledTools: [...disabled] }),
    }));
  }

  async function refresh() {
    try {
      const [s, st] = await Promise.all([j('/api/mcp/services'), j('/api/mcp/status')]);
      setServices(s); setStatus(st);
    } catch (e) { setError(String(e.message)); }
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (tab === 'takeover' && !scan) j('/api/mcp/scan').then(setScan).catch((e) => setError(String(e.message)));
    if (tab === 'inspector') {
      j('/api/mcp/log').then(setLog).catch(() => {});
      j('/api/mcp/tools').then(setTools).catch(() => {});
    }
  }, [tab]);

  async function runTakeover() {
    const names = scan.filter((i) => i.status !== 'unchanged').map((i) => i.name);
    const r = await post('/api/mcp/takeover', { names });
    setServices(r.services); setScan(null); setTab('services');
    refresh();
  }

  async function runInvoke(e) {
    e.preventDefault();
    try {
      const r = await post('/api/mcp/call', { name: invoke.name, arguments: JSON.parse(invoke.args || '{}') });
      setInvoke({ ...invoke, result: JSON.stringify(r.result, null, 2) });
    } catch (err) { setInvoke({ ...invoke, result: 'Error: ' + err.message }); }
    j('/api/mcp/log').then(setLog).catch(() => {});
  }

  return (
    <div className="page">
      <div className="project-head">
        <h2>⬢ MCP Hub</h2>
        {status && (
          <>
            <span className="pill git-pill">endpoint http://localhost:4173{status.endpoint}</span>
            <span className="pill">{status.enabled}/{status.services} services enabled</span>
            <span className="pill">{status.sessions} client session{status.sessions === 1 ? '' : 's'}</span>
            {status.connectedStdio.map((c) => (
              <span key={c.name} className="pill ok-pill">● {c.name} (pid {c.pid}, {c.tools} tools)</span>
            ))}
          </>
        )}
      </div>
      <p className="muted small">One endpoint for every AI tool: point Claude Code / Cursor / Gemini at
        <code> http://localhost:4173/mcp</code> and Chronicle aggregates all upstream services with
        namespaced tools (<code>service__tool</code>).</p>
      {error && <div className="error-banner">{error}</div>}

      <div className="filter-chips" style={{ margin: '10px 0' }}>
        {['services', 'takeover', 'inspector'].map((t) => (
          <button key={t} className={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {{ services: 'Services', takeover: 'Config takeover', inspector: 'Inspector' }[t]}
          </button>
        ))}
      </div>

      {tab === 'services' && (
        <div className="session-list">
          {services.map((s) => (
            <React.Fragment key={s.id}>
            <div className="card scan-row" style={{ borderRadius: 10 }}>
              <div className="scan-info">
                <div>{s.name} <span className="pill src-pill">{s.transport}</span>{' '}
                  <span className="muted small">{s.origin}</span></div>
                <div className="muted small">{s.command ? `${s.command} ${JSON.parse(s.args || '[]').join(' ')}` : s.url}</div>
                {s.env !== '{}' && <div className="muted small">env: {s.env}</div>}
              </div>
              {s.enabled && (
                <button className="btn tiny ghost" title="Tool policy: enable/disable individual tools"
                  onClick={() => { setPolicyFor(policyFor === s.id ? null : s.id); if (!svcTools[s.name]) loadPolicyTools(); }}>
                  ⛭ policy{JSON.parse(s.disabled_tools || '[]').length ? ` (${JSON.parse(s.disabled_tools || '[]').length} blocked)` : ''}
                </button>
              )}
              <button className={`btn small ${s.enabled ? 'primary' : ''}`}
                onClick={async () => setServices(await j(`/api/mcp/services/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) }))}>
                {s.enabled ? 'Enabled' : 'Disabled'}
              </button>
              <button className="btn tiny ghost" onClick={async () => {
                if (confirm(`Remove '${s.name}' from the hub? (source configs untouched)`))
                  setServices(await j(`/api/mcp/services/${s.id}`, { method: 'DELETE' }));
              }}>✕</button>
            </div>
            {policyFor === s.id && (
              <div className="card" style={{ marginLeft: 20 }}>
                <div className="small muted">Tool policy — unchecked tools are hidden from clients and blocked on call:</div>
                {(() => {
                  const disabled = JSON.parse(s.disabled_tools || '[]');
                  const all = [...new Set([...(svcTools[s.name] || []), ...disabled])].sort();
                  if (!all.length) return <div className="muted small pad8">Loading tools… (service must be reachable)</div>;
                  return <div className="policy-grid">
                    {all.map((t) => (
                      <label key={t} className="small policy-item">
                        <input type="checkbox" checked={!disabled.includes(t)} onChange={() => toggleTool(s, t)} /> {t}
                      </label>
                    ))}
                  </div>;
                })()}
              </div>
            )}
            </React.Fragment>
          ))}
          {!services.length && <div className="muted center pad8">No services yet — run Config takeover to import from your tools.</div>}
        </div>
      )}

      {tab === 'takeover' && (
        <div>
          <p className="muted small">Found in your tool configs (Claude Code, Cursor, Gemini, Codex). Source files are
            backed up to <code>~/.chronicle/backups/mcp/</code> before import; Chronicle never rewrites them.</p>
          {!scan && <div className="muted pad8">Scanning…</div>}
          {scan && (
            <>
              {scan.map((i) => (
                <div key={i.origin + i.name} className="scan-row">
                  <span className={`pill ${i.status === 'new' ? 'ok-pill' : i.status === 'conflict' ? 'warn-pill' : ''}`}>{i.status}</span>
                  <div className="scan-info">
                    <div>{i.name} <span className="muted small">({i.transport})</span></div>
                    <div className="muted small">{i.origin} · {i.file}</div>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 12 }}>
                <button className="btn primary" onClick={runTakeover}
                  disabled={!scan.some((i) => i.status !== 'unchanged')}>
                  Import {scan.filter((i) => i.status !== 'unchanged').length} services (with backup)
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'inspector' && (
        <div className="refine-panes" style={{ minHeight: 400 }}>
          <div style={{ flex: 1, paddingRight: 16 }}>
            <h4>Manual tool invocation</h4>
            {tools && (
              <select className="search" style={{ width: '100%' }} value={invoke.name}
                onChange={(e) => setInvoke({ ...invoke, name: e.target.value })}>
                <option value="">— pick a tool —</option>
                {tools.tools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            )}
            {tools && Object.entries(tools.errors || {}).map(([svc, err]) => (
              <div key={svc} className="error-banner small">{svc}: {err}</div>
            ))}
            <form onSubmit={runInvoke}>
              <textarea className="refine-edit" style={{ marginTop: 8 }} value={invoke.args}
                onChange={(e) => setInvoke({ ...invoke, args: e.target.value })} placeholder='{"text": "hello"}' />
              <button className="btn primary small" type="submit" disabled={!invoke.name}>Call tool</button>
            </form>
            {invoke.result && <pre className="sec-text" style={{ marginTop: 10 }}>{invoke.result}</pre>}
          </div>
          <div style={{ flex: 1, borderLeft: '1px solid var(--border)', paddingLeft: 16, overflowY: 'auto', maxHeight: 500 }}>
            <h4>JSON-RPC log <button className="btn tiny ghost" onClick={() => j('/api/mcp/log').then(setLog)}>↻</button></h4>
            {log.map((l, i) => (
              <div key={i} className="small" style={{ borderBottom: '1px solid var(--border)', padding: '4px 0' }}>
                <span className={`pill ${l.direction === 'recv' ? 'src-pill' : 'ok-pill'}`}>{l.direction}</span>{' '}
                <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span>
                <pre className="sec-text" style={{ maxHeight: 90, marginTop: 3 }}>{JSON.stringify(l.payload)}</pre>
              </div>
            ))}
            {!log.length && <div className="muted small">No traffic yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
