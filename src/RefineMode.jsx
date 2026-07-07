import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n.js';

// Refine Mode (FR-MODE-3): distill a session into clean documentation or a prompt.
// Chronicle-style: original messages left, compressed preview right, token stats +
// undo/redo/reset in a bottom status bar.
// Keep `K` / Delete `D` / Edit `E` / Insert `I`, ⌘Z undo, ⇧⌘Z redo, ⌘S export.

const KIND_META = {
  user: { label: 'USER', color: 'var(--warn)' },
  assistant: { label: 'ASSISTANT', color: 'var(--accent)' },
  thinking: { label: 'THINKING', color: 'var(--muted)' },
  tool_use: { label: 'TOOL CALL', color: '#a78bfa' },
  tool_result: { label: 'TOOL RESULT', color: 'var(--accent2)' },
  note: { label: 'INSERTED', color: 'var(--accent2)' },
};

const tokens = (text) => Math.round((text || '').length / 4);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export default function RefineMode({ messages, session, project }) {
  const initial = useMemo(() => messages.map((m) => ({
    id: `m${m.seq}`, kind: m.kind, ts: m.ts,
    text: m.kind === 'tool_use' ? `[${m.tool_name}] ${previewInput(m.tool_input)}` : (m.text || ''),
    deleted: m.kind === 'tool_result' || m.kind === 'thinking', // noisy kinds start deleted
    edited: false,
  })), [messages]);

  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState(initial[0]?.id ?? null);
  const [editingId, setEditingId] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [previewMode, setPreviewMode] = useState('full'); // full | changes | hideDeleted
  const [exportOpen, setExportOpen] = useState(false);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const [, bump] = useState(0); // re-render after undo/redo stack changes (button disabled state)
  const leftRef = useRef(null);

  function apply(next) {
    undoStack.current.push(items);
    redoStack.current = [];
    setItems(next);
    bump((n) => n + 1);
  }
  function undo() {
    const prev = undoStack.current.pop();
    if (prev) { redoStack.current.push(items); setItems(prev); bump((n) => n + 1); }
  }
  function redo() {
    const next = redoStack.current.pop();
    if (next) { undoStack.current.push(items); setItems(next); bump((n) => n + 1); }
  }
  function reset() {
    apply(initial);
  }

  function setDeleted(id, deleted) {
    apply(items.map((it) => (it.id === id ? { ...it, deleted } : it)));
  }
  function setAllDeleted(deleted) {
    apply(items.map((it) => (it.deleted === deleted ? it : { ...it, deleted })));
  }
  function insertAt(idx) {
    const newItem = { id: `ins${Date.now()}`, kind: 'note', text: '', deleted: false, edited: true, inserted: true };
    apply([...items.slice(0, idx), newItem, ...items.slice(idx)]);
    setSelected(newItem.id);
    setEditingId(newItem.id);
    if (previewMode === 'changes') setPreviewMode('full');
  }
  function insertAfter(id) {
    insertAt(items.findIndex((it) => it.id === id) + 1);
  }
  function updateText(id, text) {
    // Typing is not a separate undo step per keystroke; commit on blur via apply-once
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, text, edited: true } : it)));
  }

  const kept = items.filter((it) => !it.deleted);
  const compressedTokens = kept.reduce((s, it) => s + tokens(it.text), 0);
  const originalTokens = initial.reduce((s, it) => s + tokens(it.text), 0);
  const saved = Math.max(0, originalTokens - compressedTokens);
  const savedPct = originalTokens ? Math.round((saved / originalTokens) * 100) : 0;
  const nDeleted = items.filter((it) => it.deleted && !it.inserted).length;
  const nEdited = items.filter((it) => it.edited && !it.inserted).length;
  const nInserted = items.filter((it) => it.inserted).length;

  const previewItems = previewMode === 'hideDeleted' ? kept
    : previewMode === 'changes' ? items.filter((it) => it.deleted || it.edited || it.inserted)
    : items;

  function exportDoc(asPrompt) {
    setExportOpen(false);
    const lines = kept.map((it) => {
      const label = { user: 'User', assistant: 'Assistant', thinking: 'Thinking', tool_use: 'Tool', tool_result: 'Result', note: 'Note' }[it.kind] || it.kind;
      return asPrompt ? it.text : `### ${label}\n\n${it.text}`;
    });
    const header = asPrompt ? '' : `# ${project?.name ?? 'Session'} — refined session\n\n> Source: ${session?.source} · ${session?.started_at ?? ''} · ${kept.length}/${items.length} messages kept · ~${fmtTok(compressedTokens)} tokens\n\n`;
    const blob = new Blob([header + lines.join('\n\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(project?.name || 'session')}-${asPrompt ? 'prompt' : 'refined'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  useEffect(() => {
    function onKey(e) {
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault(); e.shiftKey ? redo() : undo(); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); exportDoc(false); return;
      }
      if (typing) return;
      const idx = items.findIndex((it) => it.id === selected);
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveSel(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k' && e.shiftKey) { e.preventDefault(); moveSel(-1); }
      else if (e.key.toLowerCase() === 'k' && !e.shiftKey) { if (selected) setDeleted(selected, false); moveSel(1); }
      else if (e.key.toLowerCase() === 'd') { if (selected) setDeleted(selected, true); moveSel(1); }
      else if (e.key.toLowerCase() === 'e') { if (selected) setEditingId(selected); }
      else if (e.key.toLowerCase() === 'i') { if (selected) insertAfter(selected); }
      function moveSel(dir) {
        const next = items[Math.min(items.length - 1, Math.max(0, idx + dir))];
        if (next) {
          setSelected(next.id);
          leftRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function toggleExpand(id) {
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const COLLAPSE_AT = 280;

  return (
    <div className="refine">
      <div className="refine-panes">
        <div className="refine-left" ref={leftRef}>
          <div className="refine-bulk">
            <button className="btn ghost small" onClick={() => insertAt(0)}>＋ {t('Insert at start')}</button>
            <button className="btn ghost small" title={t('Keep every message')}
              onClick={() => setAllDeleted(false)}>✓ {t('Keep All')}</button>
            <button className="btn ghost small" title={t('Delete every message')}
              onClick={() => setAllDeleted(true)}>🗑 {t('Delete All')}</button>
          </div>
          {items.map((it) => {
            const meta = KIND_META[it.kind] || { label: it.kind, color: 'var(--muted)' };
            const long = it.text.length > COLLAPSE_AT;
            const open = expanded.has(it.id);
            return (
              <div key={it.id} data-id={it.id}
                className={`refine-item ${it.deleted ? 'deleted' : ''} ${selected === it.id ? 'selected' : ''}`}
                onClick={() => setSelected(it.id)}>
                <div className="refine-item-head">
                  <span className="refine-kind" style={{ color: meta.color }}>
                    {meta.label}{it.edited && !it.inserted ? <span className="muted"> · {t('edited')}</span> : ''}
                  </span>
                  <span className="refine-head-right">
                    <span className="refine-ops">
                      <button className={`btn tiny ghost keep-btn ${!it.deleted ? 'on' : ''}`} title={`${t('Keep')} (K)`}
                        onClick={(e) => { e.stopPropagation(); setDeleted(it.id, false); }}>✓</button>
                      <button className="btn tiny ghost" title={`${t('Delete')} (D)`}
                        onClick={(e) => { e.stopPropagation(); setDeleted(it.id, true); }}>🗑</button>
                      <button className="btn tiny ghost" title={`${t('Edit')} (E)`}
                        onClick={(e) => { e.stopPropagation(); setSelected(it.id); setEditingId(it.id); }}>✎</button>
                      <button className="btn tiny ghost" title={`${t('Insert after')} (I)`}
                        onClick={(e) => { e.stopPropagation(); insertAfter(it.id); }}>＋</button>
                    </span>
                    <span className="pill tok-pill">{tokens(it.text)} tokens</span>
                  </span>
                </div>
                <div className={`refine-item-body ${open ? 'open' : ''}`}>
                  {open || !long ? it.text : it.text.slice(0, COLLAPSE_AT) + '…'}
                </div>
                {long && (
                  <button className="btn ghost tiny expand-btn" onClick={(e) => { e.stopPropagation(); toggleExpand(it.id); }}>
                    {open ? `▴ ${t('Collapse')}` : `▾ ${t('Expand')}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="refine-right">
          <div className="refine-right-head">
            <strong>{t('Compressed Preview')}</strong>
            <span className="filter-chips">
              <button className={`chip ${previewMode === 'full' ? 'on' : ''}`} onClick={() => setPreviewMode('full')}>👁 {t('Full')}</button>
              <button className={`chip ${previewMode === 'changes' ? 'on' : ''}`} onClick={() => setPreviewMode('changes')}>≶ {t('Changes Only')}</button>
              <button className={`chip ${previewMode === 'hideDeleted' ? 'on' : ''}`} onClick={() => setPreviewMode('hideDeleted')}>⌦ {t('Hide Deleted')}</button>
            </span>
          </div>
          <div className="refine-right-body">
            {previewItems.map((it) => {
              const meta = KIND_META[it.kind] || { label: it.kind, color: 'var(--muted)' };
              return (
                <div key={it.id} className={`preview-block ${it.kind} ${it.deleted ? 'deleted' : ''}`}>
                  <div className="preview-block-head">
                    <span className="refine-kind" style={{ color: meta.color }}>
                      {meta.label}
                      {it.deleted ? <span className="bad"> · {t('deleted')}</span> : it.inserted ? <span className="ok"> · {t('inserted')}</span> : it.edited ? <span className="muted"> · {t('edited')}</span> : ''}
                    </span>
                    <span className="pill tok-pill">{tokens(it.text)} tokens</span>
                  </div>
                  {editingId === it.id ? (
                    <textarea autoFocus className="refine-edit" value={it.text}
                      onChange={(e) => updateText(it.id, e.target.value)}
                      onBlur={() => { setEditingId(null); apply([...items]); }}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingId(null); }} />
                  ) : (
                    <div className="preview-text" onDoubleClick={() => { setSelected(it.id); setEditingId(it.id); }}>
                      {it.text ? (it.text.length > 600 && !expanded.has(it.id) ? it.text.slice(0, 600) + '…' : it.text)
                        : <span className="muted">({t('empty — double-click to edit')})</span>}
                    </div>
                  )}
                </div>
              );
            })}
            {!previewItems.length && <div className="muted center pad8">{t('Nothing to show in this view.')}</div>}
          </div>
        </div>
      </div>

      <div className="refine-statusbar">
        <span className="refine-history">
          <button className="btn tiny ghost" title={`${t('Undo')} (⌘Z)`} disabled={!undoStack.current.length} onClick={undo}>↶</button>
          <button className="btn tiny ghost" title={`${t('Redo')} (⇧⌘Z)`} disabled={!redoStack.current.length} onClick={redo}>↷</button>
          <button className="btn tiny ghost" title={t('Reset all changes')} disabled={!undoStack.current.length && !redoStack.current.length} onClick={reset}>⟲</button>
        </span>
        <span className="refine-totals"
          title={t('Size of the export document (tool calls truncated to one-line previews) — not the model context window')}>
          <span className="muted small">{t('Original')}</span> <b>{fmtTok(originalTokens)}</b>
          <span className="muted">→</span>
          <span className="muted small">{t('Compressed')}</span> <b className="token-stats">{fmtTok(compressedTokens)}</b>
          <span className="muted small">{t('Saved')}</span> <b>{fmtTok(saved)}</b>
        </span>
        <span className="refine-bars">
          <span className="refine-bar"><span style={{ width: '100%' }} /></span>
          <span className="refine-bar"><span className="ok-bar" style={{ width: `${originalTokens ? Math.min(100, (compressedTokens / originalTokens) * 100) : 0}%` }} /></span>
          <span className="small token-stats">{savedPct}%</span>
        </span>
        <span className="refine-counts muted small" title={t('deleted / edited / inserted')}>
          <span className="bad">− {nDeleted}</span> <span>✎ {nEdited}</span> <span className="ok">＋ {nInserted}</span>
        </span>
        <span className="refine-export">
          <button className="btn small primary" onClick={() => setExportOpen((o) => !o)}>{t('Export')} ▾</button>
          {exportOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setExportOpen(false)} />
              <div className="menu-pop export-pop">
                <button className="menu-item" onClick={() => exportDoc(false)}>📄 {t('Export Markdown')}</button>
                <button className="menu-item" onClick={() => exportDoc(true)}>⌁ {t('Export as Prompt')}</button>
              </div>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function previewInput(inputJson) {
  try {
    const input = JSON.parse(inputJson || '{}');
    return input.file_path || input.command || input.pattern || input.query || JSON.stringify(input).slice(0, 120);
  } catch { return (inputJson || '').slice(0, 120); }
}
