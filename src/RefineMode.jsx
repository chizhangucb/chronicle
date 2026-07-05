import React, { useEffect, useMemo, useRef, useState } from 'react';

// Refine Mode (FR-MODE-3): distill a session into clean documentation or a prompt.
// Original messages on the left; live preview/edit on the right.
// Keep `K` / Delete `D` / Edit `E` / Insert `I`, ⌘Z undo, ⇧⌘Z redo, ⌘S export.
export default function RefineMode({ messages, session, project }) {
  const initial = useMemo(() => messages.map((m) => ({
    id: `m${m.seq}`, kind: m.kind, ts: m.ts,
    text: m.kind === 'tool_use' ? `${m.tool_name}: ${previewInput(m.tool_input)}` : (m.text || ''),
    deleted: m.kind === 'tool_result' || m.kind === 'thinking', // noisy kinds start deleted
    edited: false,
  })), [messages]);

  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState(initial[0]?.id ?? null);
  const [editingId, setEditingId] = useState(null);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const leftRef = useRef(null);

  function apply(next) {
    undoStack.current.push(items);
    redoStack.current = [];
    setItems(next);
  }
  function undo() {
    const prev = undoStack.current.pop();
    if (prev) { redoStack.current.push(items); setItems(prev); }
  }
  function redo() {
    const next = redoStack.current.pop();
    if (next) { undoStack.current.push(items); setItems(next); }
  }

  function setDeleted(id, deleted) {
    apply(items.map((it) => (it.id === id ? { ...it, deleted } : it)));
  }
  function insertAfter(id) {
    const idx = items.findIndex((it) => it.id === id);
    const newItem = { id: `ins${Date.now()}`, kind: 'note', text: '', deleted: false, edited: true, inserted: true };
    apply([...items.slice(0, idx + 1), newItem, ...items.slice(idx + 1)]);
    setSelected(newItem.id);
    setEditingId(newItem.id);
  }
  function updateText(id, text) {
    // Typing is not a separate undo step per keystroke; commit on blur via apply-once
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, text, edited: true } : it)));
  }

  const kept = items.filter((it) => !it.deleted);
  const tokenEstimate = Math.round(kept.reduce((s, it) => s + it.text.length, 0) / 4);
  const originalTokens = Math.round(items.filter((i) => !i.inserted).reduce((s, it) => s + it.text.length, 0) / 4);

  function exportDoc(asPrompt) {
    const lines = kept.map((it) => {
      const label = { user: 'User', assistant: 'Assistant', thinking: 'Thinking', tool_use: 'Tool', tool_result: 'Result', note: 'Note' }[it.kind] || it.kind;
      return asPrompt ? it.text : `### ${label}\n\n${it.text}`;
    });
    const header = asPrompt ? '' : `# ${project?.name ?? 'Session'} — refined session\n\n> Source: ${session?.source} · ${session?.started_at ?? ''} · ${kept.length}/${items.length} messages kept\n\n`;
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

  return (
    <div className="refine">
      <div className="refine-toolbar">
        <span className="muted small">
          <b>K</b> keep · <b>D</b> delete · <b>E</b> edit · <b>I</b> insert · <b>⌘Z</b> undo · <b>⌘S</b> export
        </span>
        <span className="token-stats">
          {kept.length}/{items.length} messages · ~{tokenEstimate.toLocaleString()} tokens
          <span className="muted small"> (was ~{originalTokens.toLocaleString()}, {originalTokens ? Math.round((1 - tokenEstimate / originalTokens) * 100) : 0}% saved)</span>
        </span>
        <span>
          <button className="btn small" onClick={() => exportDoc(false)}>Export Markdown</button>{' '}
          <button className="btn small" onClick={() => exportDoc(true)}>Export as Prompt</button>
        </span>
      </div>
      <div className="refine-panes">
        <div className="refine-left" ref={leftRef}>
          {items.map((it) => (
            <div key={it.id} data-id={it.id}
              className={`refine-item ${it.deleted ? 'deleted' : ''} ${selected === it.id ? 'selected' : ''}`}
              onClick={() => setSelected(it.id)}>
              <div className="refine-item-head">
                <span className="msg-kind small">{it.inserted ? '✎ inserted' : it.kind}{it.edited && !it.inserted ? ' · edited' : ''}</span>
                <span className="refine-ops">
                  <button className="btn tiny ghost" title="Keep (K)" onClick={(e) => { e.stopPropagation(); setDeleted(it.id, false); }}>✓</button>
                  <button className="btn tiny ghost" title="Delete (D)" onClick={(e) => { e.stopPropagation(); setDeleted(it.id, true); }}>✕</button>
                  <button className="btn tiny ghost" title="Edit (E)" onClick={(e) => { e.stopPropagation(); setSelected(it.id); setEditingId(it.id); }}>✎</button>
                  <button className="btn tiny ghost" title="Insert after (I)" onClick={(e) => { e.stopPropagation(); insertAfter(it.id); }}>＋</button>
                </span>
              </div>
              <div className="refine-item-body">{it.text.slice(0, 400)}{it.text.length > 400 ? '…' : ''}</div>
            </div>
          ))}
        </div>
        <div className="refine-right">
          {kept.map((it) => (
            <div key={it.id} className={`preview-block ${it.kind}`}>
              <div className="muted small">{it.kind === 'note' ? 'inserted note' : it.kind}</div>
              {editingId === it.id ? (
                <textarea autoFocus className="refine-edit" value={it.text}
                  onChange={(e) => updateText(it.id, e.target.value)}
                  onBlur={() => { setEditingId(null); apply([...items]); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') setEditingId(null); }} />
              ) : (
                <div className="preview-text" onDoubleClick={() => { setSelected(it.id); setEditingId(it.id); }}>{it.text || <span className="muted">(empty — double-click to edit)</span>}</div>
              )}
            </div>
          ))}
          {!kept.length && <div className="muted center pad8">Nothing kept yet — press K on messages to keep them.</div>}
        </div>
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
