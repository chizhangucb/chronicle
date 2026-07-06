import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';

const SOURCES = [
  { key: 'claude-code', label: 'Claude Code', hint: '~/.claude/projects/', icon: '✳' },
  { key: 'codex', label: 'Codex', hint: '~/.codex/sessions/', icon: '⬡' },
  { key: 'cursor', label: 'Cursor', hint: 'workspaceStorage (read-only)', icon: '▮' },
  { key: 'opencode', label: 'OpenCode', hint: 'opencode.db (read-only)', icon: '▣' },
  { key: 'gemini-cli', label: 'Gemini CLI', hint: '~/.gemini/tmp/', icon: '✦' },
  { key: 'copilot-chat', label: 'Copilot Chat', hint: 'VS Code chatSessions', icon: '⌘' },
];

const STEPS = ['Select Source', 'Select Files', 'Importing', 'Complete'];

const projKey = (item) => `${item.source}|${item.logDir}|${item.directory || item.physicalPath || item.name}`;
const sessKey = (pk, sid) => `${pk}##${sid}`;
const granular = (item) => Array.isArray(item.sessions) && item.sessions.length > 0;
// Selectable units of a project: one per session when we can enumerate them,
// otherwise the whole project is a single unit.
const unitsOf = (item) => (granular(item)
  ? item.sessions.map((s) => ({ key: sessKey(projKey(item), s.id), imported: s.imported }))
  : [{ key: projKey(item), imported: item.imported }]);

function badgeOf(item) {
  if (granular(item)) {
    const done = item.sessions.filter((s) => s.imported).length;
    if (done === item.sessions.length) return { kind: 'imported', text: t('Imported') };
    if (done > 0) return { kind: 'partial', text: `${t('Partial')} ${done}/${item.sessions.length}` };
    return { kind: 'new', text: 'NEW' };
  }
  return item.imported ? { kind: 'imported', text: t('Imported') } : { kind: 'new', text: 'NEW' };
}

export default function ImportWizard({ onClose, onImported }) {
  const [step, setStep] = useState(1);
  const [scan, setScan] = useState(null);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [extraItems, setExtraItems] = useState([]); // from "Select Directory Manually"
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());
  const [query, setQuery] = useState('');
  const [dirForm, setDirForm] = useState(null); // null | current input value
  const [rescanning, setRescanning] = useState(false);
  const [jobs, setJobs] = useState([]); // [{item, payload, status, result, error}]

  useEffect(() => {
    api.scan().then(setScan).catch((e) => setError(String(e.message)));
  }, []);

  const items = useMemo(() => {
    if (!scan || !source) return [];
    const base = scan[source] || [];
    const seen = new Set(base.map(projKey));
    return [...base, ...extraItems.filter((i) => i.source === source && !seen.has(projKey(i)))];
  }, [scan, source, extraItems]);

  const allUnits = useMemo(() => items.flatMap(unitsOf), [items]);
  const importedUnits = allUnits.filter((u) => u.imported).length;
  const totalSessions = items.reduce((s, i) => s + (i.sessionCount || 0), 0);
  const selectedSessions = items.reduce((s, i) => {
    if (granular(i)) return s + i.sessions.filter((x) => selected.has(sessKey(projKey(i), x.id))).length;
    return s + (selected.has(projKey(i)) ? i.sessionCount || 1 : 0);
  }, 0);
  const selectedProjects = items.filter((i) => unitsOf(i).some((u) => selected.has(u.key))).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items
      .map((i) => {
        const projHit = i.name.toLowerCase().includes(q) || (i.physicalPath || '').toLowerCase().includes(q);
        const sess = granular(i)
          ? i.sessions.filter((s) => s.id.toLowerCase().includes(q) || (s.label || '').toLowerCase().includes(q))
          : null;
        if (projHit) return i;
        if (sess?.length) return { ...i, sessions: sess, _sessionMatch: true };
        return null;
      })
      .filter(Boolean);
  }, [items, query]);

  function selectAllNew(list = items) {
    setSelected(new Set(list.flatMap(unitsOf).filter((u) => !u.imported).map((u) => u.key)));
  }
  function chooseSource(key) {
    setSource(key);
    const list = (scan[key] || []);
    setSelected(new Set(list.flatMap(unitsOf).filter((u) => !u.imported).map((u) => u.key)));
    setExpanded(new Set());
    setQuery('');
    setStep(2);
  }
  function toggleUnit(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function toggleProject(item) {
    const units = unitsOf(item).map((u) => u.key);
    setSelected((prev) => {
      const next = new Set(prev);
      const all = units.every((k) => next.has(k));
      units.forEach((k) => (all ? next.delete(k) : next.add(k)));
      return next;
    });
  }
  function invert() {
    setSelected((prev) => new Set(allUnits.map((u) => u.key).filter((k) => !prev.has(k))));
  }
  async function rescan() {
    setRescanning(true);
    setError(null);
    try {
      const fresh = await api.scan();
      setScan(fresh);
      // Keep only selections that still exist; newly-appeared NEW sessions get selected.
      const freshItems = fresh[source] || [];
      const freshUnits = freshItems.flatMap(unitsOf);
      setSelected((prev) => new Set(freshUnits
        .filter((u) => prev.has(u.key) || !u.imported)
        .map((u) => u.key)));
    } catch (e) { setError(String(e.message)); }
    finally { setRescanning(false); }
  }
  async function scanDirectory() {
    if (!dirForm?.trim()) return;
    setError(null);
    try {
      const result = await api.scan({ source, dir: dirForm.trim() });
      const found = result[source] || [];
      if (!found.length) { setError(t('No importable sessions found in that directory')); return; }
      setExtraItems((prev) => [...prev, ...found]);
      setSelected((prev) => {
        const next = new Set(prev);
        found.flatMap(unitsOf).filter((u) => !u.imported).forEach((u) => next.add(u.key));
        return next;
      });
      setDirForm(null);
    } catch (e) { setError(String(e.message)); }
  }

  async function startImport() {
    // One import job per project that has selected units.
    const built = [];
    for (const item of items) {
      const pk = projKey(item);
      if (granular(item)) {
        const chosen = item.sessions.filter((s) => selected.has(sessKey(pk, s.id)));
        if (!chosen.length) continue;
        const payload = { source: item.source, logDir: item.logDir, directory: item.directory };
        if (item.source === 'opencode') payload.sessionIds = chosen.map((s) => s.id);
        else payload.files = chosen.map((s) => s.file);
        built.push({ item, payload, count: chosen.length, status: 'pending' });
      } else if (selected.has(pk)) {
        built.push({
          item,
          payload: { source: item.source, logDir: item.logDir, directory: item.directory, files: item.files },
          count: item.sessionCount || 1,
          status: 'pending',
        });
      }
    }
    if (!built.length) return;
    setJobs(built);
    setStep(3);
    for (let i = 0; i < built.length; i++) {
      setJobs((js) => js.map((j, k) => (k === i ? { ...j, status: 'importing' } : j)));
      try {
        const result = await api.import(built[i].payload);
        built[i] = { ...built[i], status: 'done', result };
      } catch (e) {
        built[i] = { ...built[i], status: 'failed', error: String(e.message) };
      }
      setJobs([...built]);
    }
    onImported();
    setStep(4);
  }

  // ---- Step 4 aggregates ----
  const doneJobs = jobs.filter((j) => j.status === 'done');
  const failedJobs = jobs.filter((j) => j.status === 'failed');
  const importedSessions = doneJobs.reduce((s, j) => s + (j.result?.imported || 0), 0);
  const importedMessages = doneJobs.reduce((s, j) => s + (j.result?.totalMessages || 0), 0);
  const resultProjects = [];
  for (const j of doneJobs) for (const p of j.result?.projects || []) {
    const existing = resultProjects.find((x) => x.id === p.id);
    if (existing) { existing.sessions += p.sessions; existing.messages += p.messages; existing.created = existing.created || p.created; }
    else resultProjects.push({ ...p });
  }
  const emptyJobs = doneJobs.filter((j) => (j.result?.imported || 0) === 0 && (j.result?.skippedSessions || 0) > 0);
  const progressDone = jobs.filter((j) => j.status === 'done' || j.status === 'failed').length;

  return (
    <div className="modal-backdrop" onClick={step === 3 ? undefined : onClose}>
      <div className="modal wizard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t('Import Logs')}</h3>
          {step !== 3 && <button className="btn ghost" onClick={onClose}>✕</button>}
        </div>

        <div className="wiz-steps">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const state = n < step ? 'done' : n === step ? 'on' : '';
            return (
              <React.Fragment key={label}>
                {i > 0 && <div className={`wiz-step-line ${n <= step ? 'done' : ''}`} />}
                <div className={`wiz-step ${state}`}>
                  <span className="wiz-step-dot">{n < step ? '✓' : n}</span>
                  <span className="wiz-step-label">{t(label)}</span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {step === 1 && (
          <div className="wiz-body">
            {!scan && <div className="muted center" style={{ padding: 32 }}>{t('Scanning local sources…')}</div>}
            {scan && (
              <>
                <div className="wiz-source-section muted small">◎ {t('Local')}</div>
                <div className="wiz-source-grid">
                  {SOURCES.filter((s) => (scan[s.key] || []).length).map((s) => {
                    const list = scan[s.key];
                    const sessions = list.reduce((n, i) => n + (i.sessionCount || 0), 0);
                    return (
                      <button key={s.key} className="wiz-source-card" onClick={() => chooseSource(s.key)}>
                        <span className="wiz-source-icon">{s.icon}</span>
                        <span className="wiz-source-name">{s.label}</span>
                        <span className="muted small">{sessions} {t('sessions')}</span>
                      </button>
                    );
                  })}
                  {SOURCES.every((s) => !(scan[s.key] || []).length) && (
                    <div className="muted pad8">{t('No local AI tool logs found.')}</div>
                  )}
                </div>
                <p className="muted small" style={{ marginTop: 16 }}>
                  {t('Chronicle scans each tool\'s standard log location. Importing is read-only — your original logs are never modified.')}
                </p>
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <>
            <div className="wiz-toolbar">
              <button className="btn small" disabled={rescanning} onClick={rescan}>◎ {rescanning ? t('Rescanning…') : t('Rescan')}</button>
              <button className="btn small" onClick={() => setDirForm(dirForm === null ? '' : null)}>🗀 {t('Select Directory Manually')}</button>
              <input className="input wiz-search" placeholder={'🔍 ' + t('Search projects or sessions')}
                value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {dirForm !== null && (
              <div className="wiz-dir-form">
                <input className="input" style={{ flex: 1 }} autoFocus placeholder={t('Absolute path to a log directory…')}
                  value={dirForm} onChange={(e) => setDirForm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && scanDirectory()} />
                <button className="btn small" onClick={scanDirectory}>{t('Scan')}</button>
              </div>
            )}
            <div className="wiz-summary muted small">
              <span>🗀 {items.length} {t('projects')}</span>
              <span className="accent">{selectedProjects} {t('selected')}</span>
              <span>▤ {totalSessions} {t('sessions')}</span>
              <span className="accent">{selectedSessions} {t('selected')}</span>
              <span>⇩ {importedUnits} {t('imported')}</span>
            </div>
            <div className="wiz-tree">
              {!filtered.length && <div className="muted center pad8">{t('No projects match.')}</div>}
              {filtered.map((item) => {
                const pk = projKey(item);
                const units = unitsOf(item).map((u) => u.key);
                const nSel = units.filter((k) => selected.has(k)).length;
                const badge = badgeOf(item);
                const isOpen = expanded.has(pk) || item._sessionMatch;
                return (
                  <div key={pk} className="wiz-proj">
                    <div className="wiz-proj-row">
                      {granular(item) ? (
                        <button className="btn ghost tiny wiz-chevron" onClick={() =>
                          setExpanded((prev) => { const n = new Set(prev); n.has(pk) ? n.delete(pk) : n.add(pk); return n; })}>
                          {isOpen ? '▾' : '▸'}
                        </button>
                      ) : <span className="wiz-chevron" />}
                      <input type="checkbox" checked={nSel === units.length && units.length > 0}
                        ref={(el) => el && (el.indeterminate = nSel > 0 && nSel < units.length)}
                        onChange={() => toggleProject(item)} />
                      <div className="wiz-proj-info" onClick={() => toggleProject(item)}>
                        <span className={badge.kind === 'imported' ? 'muted' : ''}>🗀 {item.name}</span>
                        <span className="muted small mono-path">{item.physicalPath || item.logDir}</span>
                      </div>
                      <span className={`pill wiz-badge ${badge.kind}`}>{badge.text}</span>
                      <span className="muted small wiz-count" title={t('Estimated raw log entries — imported message counts are lower after noise filtering')}>
                        {item.sessionCount} {t('sessions')} · ~{item.messageEstimate} {t('entries')}
                      </span>
                    </div>
                    {isOpen && granular(item) && (
                      <div className="wiz-sessions">
                        {item.sessions.map((s) => {
                          const sk = sessKey(pk, s.id);
                          return (
                            <label key={sk} className="wiz-sess-row">
                              <input type="checkbox" checked={selected.has(sk)} onChange={() => toggleUnit(sk)} />
                              <span className="wiz-sess-label">{s.label || s.id}</span>
                              {s.modifiedAt && <span className="muted small">{new Date(s.modifiedAt).toLocaleDateString()}</span>}
                              <span className="muted small" title={t('Estimated raw log entries — imported message counts are lower after noise filtering')}>~{s.messageEstimate}</span>
                              {s.imported
                                ? <span className="pill wiz-badge imported">{t('Imported')}</span>
                                : <span className="pill wiz-badge new">NEW</span>}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="wiz-footer">
              <div className="wiz-footer-left">
                <button className="btn ghost small" onClick={() => selectAllNew()}>{t('Select All New')}</button>
                <button className="btn ghost small" onClick={() => setSelected(new Set())}>{t('Clear')}</button>
                <button className="btn ghost small" onClick={invert}>{t('Invert')}</button>
              </div>
              <div className="wiz-footer-right">
                <button className="btn" onClick={() => { setSource(null); setStep(1); }}>{t('Back')}</button>
                <button className="btn primary" disabled={!selected.size} onClick={startImport}>{t('Start Import')}</button>
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <div className="wiz-body">
            <div className="wiz-progress-track"><div className="wiz-progress-fill" style={{ width: `${jobs.length ? (progressDone / jobs.length) * 100 : 0}%` }} /></div>
            <div className="muted small center" style={{ margin: '6px 0 12px' }}>{progressDone}/{jobs.length} {t('projects')}</div>
            {jobs.map((j, i) => (
              <div key={i} className="wiz-job-row">
                <span className="wiz-job-status">
                  {j.status === 'pending' && '○'}
                  {j.status === 'importing' && <span className="spin">◌</span>}
                  {j.status === 'done' && <span className="ok">✓</span>}
                  {j.status === 'failed' && <span className="bad">✗</span>}
                </span>
                <span>{j.item.name}</span>
                <span className="muted small">{j.count} {t('sessions')}</span>
                {j.status === 'done' && <span className="muted small">{j.result.totalMessages} {t('messages')}</span>}
                {j.status === 'failed' && <span className="bad small">{j.error}</span>}
              </div>
            ))}
          </div>
        )}

        {step === 4 && (
          <div className="wiz-body">
            <div className="wiz-complete-head">
              <div className={`wiz-complete-icon ${failedJobs.length ? 'warn' : 'ok'}`}>{failedJobs.length ? '⚠' : '✓'}</div>
              <h3>{t('Import Complete')}</h3>
              <p className="muted small">
                {failedJobs.length ? t('Some files failed to import, please check the error messages') : t('All selected sessions were imported successfully')}
              </p>
            </div>
            <div className="wiz-stat-cards">
              <div className="wiz-stat-card"><div className="wiz-stat-num ok">{importedSessions}</div><div className="muted small">{t('Successfully Imported')}</div></div>
              <div className="wiz-stat-card"><div className={`wiz-stat-num ${failedJobs.length ? 'bad' : ''}`}>{failedJobs.length}</div><div className="muted small">{t('Import Failed')}</div></div>
              <div className="wiz-stat-card"><div className="wiz-stat-num accent">{resultProjects.length}</div><div className="muted small">{t('Projects')}</div></div>
            </div>
            {resultProjects.length > 0 && (
              <>
                <div className="muted small" style={{ margin: '14px 0 6px' }}>{t('Just Imported')}</div>
                {resultProjects.map((p) => (
                  <div key={p.id} className="wiz-result-row">
                    <div>
                      <div>🗀 {p.name}</div>
                      <div className={`small ${p.created ? 'ok' : 'muted'}`}>{p.created ? `+ ${t('Created new project')}` : t('Updated existing project')}</div>
                    </div>
                    <span className="muted small">🗨 {p.sessions} · {p.messages} {t('messages')}</span>
                  </div>
                ))}
              </>
            )}
            {failedJobs.map((j, i) => (
              <div key={i} className="error-banner small">{j.item.name}: {j.error}</div>
            ))}
            {emptyJobs.length > 0 && (
              <div className="wiz-warn-box small">
                <div>ⓘ {t('The following projects have all empty sessions')}</div>
                <div className="muted">{t('Nothing importable was found in their logs (only noise or empty sessions)')}</div>
                {emptyJobs.map((j, i) => <div key={i}>🗀 {j.item.name}</div>)}
              </div>
            )}
            <p className="muted small" style={{ marginTop: 12 }}>
              {t('Imported message counts are lower than scan estimates: raw log entries such as subagent chatter, system reminders and command echoes are filtered out.')}
            </p>
            <div className="wiz-footer">
              <div />
              <div className="wiz-footer-right">
                <button className="btn ghost small" onClick={() => { setJobs([]); setStep(2); rescan(); }}>{t('Import more')}</button>
                <button className="btn primary" onClick={onClose}>{t('Done')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
