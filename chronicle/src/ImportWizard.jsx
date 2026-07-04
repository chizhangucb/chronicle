import React, { useEffect, useState } from 'react';
import { api } from './api.js';

const SOURCES = [
  { key: 'claude-code', label: 'Claude Code', hint: '~/.claude/projects/' },
  { key: 'codex', label: 'Codex', hint: '~/.codex/sessions/' },
];

export default function ImportWizard({ onClose, onImported }) {
  const [scan, setScan] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // logDir being imported
  const [done, setDone] = useState({}); // logDir -> result

  useEffect(() => {
    api.scan().then(setScan).catch((e) => setError(String(e.message)));
  }, []);

  async function runImport(item) {
    setBusy(item.logDir + item.name);
    setError(null);
    try {
      const result = await api.import({ source: item.source, logDir: item.logDir, files: item.files });
      setDone((d) => ({ ...d, [item.logDir + item.name]: result }));
      onImported();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Import sessions</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted small">Chronicle scans each tool's standard log location. Importing is read-only — your original logs are never modified.</p>
        {error && <div className="error-banner">{error}</div>}
        {!scan && !error && <div className="muted center" style={{ padding: 24 }}>Scanning local sources…</div>}
        {scan && SOURCES.map((src) => {
          const items = scan[src.key] || [];
          return (
            <div key={src.key} className="scan-group">
              <div className="scan-group-head">
                <strong>{src.label}</strong> <span className="muted small">{src.hint}</span>
              </div>
              {!items.length && <div className="muted small pad8">No projects found.</div>}
              {items.map((item) => {
                const k = item.logDir + item.name;
                const result = done[k];
                return (
                  <div key={k} className="scan-row">
                    <div className="scan-info">
                      <div>{item.name}</div>
                      <div className="muted small">{item.physicalPath || item.logDir}</div>
                    </div>
                    <div className="muted small">{item.sessionCount} sessions · ~{item.messageEstimate} msgs</div>
                    {result
                      ? <span className="pill ok-pill">✓ {result.totalMessages} messages</span>
                      : <button className="btn" disabled={busy !== null}
                          onClick={() => runImport(item)}>
                          {busy === k ? 'Importing…' : item.imported ? 'Re-import' : 'Import'}
                        </button>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
