import React, { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { api } from './api.js';

// Code Snapshot Panel (FR-TT-3/4): file tree at the snapshot commit,
// file content, diff toggle (toolbar + `D`), changed-file highlighting.
export default function CodePanel({ projectId, commit, noRepo }) {
  const [tree, setTree] = useState({ files: [], changed: [] });
  const [selectedPath, setSelectedPath] = useState(null);
  const [file, setFile] = useState(null); // {content, previous, prevCommit}
  const [diffMode, setDiffMode] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');

  useEffect(() => {
    if (!commit) return;
    let stale = false;
    api.gitTree(projectId, commit.hash).then((t) => {
      if (stale) return;
      setTree(t);
      // Auto-select the first file changed in this commit, else keep selection
      setSelectedPath((cur) => {
        if (t.changed.length && (!cur || !t.files.includes(cur))) return t.changed[0];
        if (cur && t.files.includes(cur)) return cur;
        return t.changed[0] || t.files[0] || null;
      });
    }).catch(() => {});
    return () => { stale = true; };
  }, [projectId, commit?.hash]);

  useEffect(() => {
    if (!commit || !selectedPath) { setFile(null); return; }
    let stale = false;
    api.gitFile(projectId, commit.hash, selectedPath).then((f) => { if (!stale) setFile(f); }).catch(() => setFile(null));
    return () => { stale = true; };
  }, [projectId, commit?.hash, selectedPath]);

  // `D` toggles diff view (when not typing in an input)
  useEffect(() => {
    function onKey(e) {
      if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey &&
          !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        setDiffMode((d) => !d);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shownFiles = useMemo(() => {
    const f = treeFilter.trim().toLowerCase();
    return f ? tree.files.filter((p) => p.toLowerCase().includes(f)) : tree.files;
  }, [tree.files, treeFilter]);

  if (noRepo) {
    return (
      <div className="code-pane empty-state center">
        <div className="empty-icon">⎇</div>
        <h3>No Git history</h3>
        <p className="muted small">Time travel reconstructs code from Git commits.<br />
          This project isn't a Git repository (or has no commits), so snapshots aren't available.<br />
          Conversation playback still works. More frequent commits = higher replay fidelity.</p>
      </div>
    );
  }

  return (
    <div className="code-pane">
      <div className="code-toolbar">
        {commit ? (
          <span className="commit-info" title={commit.hash}>
            <span className="pill git-pill">⎇ {commit.hash.slice(0, 7)}</span>
            <span className="commit-subject">{commit.subject}</span>
            <span className="muted small">{new Date(commit.date).toLocaleString()}</span>
            {commit.beforeHistory && <span className="pill warn-pill">before first commit</span>}
          </span>
        ) : <span className="muted small">Select a message to load its code snapshot</span>}
        <button className={`btn small ${diffMode ? 'primary' : ''}`}
          onClick={() => setDiffMode(!diffMode)} title="Toggle diff view (D)">± Diff</button>
      </div>
      <div className="code-body">
        <div className="file-tree">
          <input className="search small" placeholder="Filter files…" value={treeFilter}
            onChange={(e) => setTreeFilter(e.target.value)} />
          {shownFiles.slice(0, 800).map((p) => (
            <div key={p}
              className={`tree-item ${p === selectedPath ? 'selected' : ''} ${tree.changed.includes(p) ? 'changed' : ''}`}
              title={p} onClick={() => setSelectedPath(p)}>
              {tree.changed.includes(p) && <span className="dot" />}{p}
            </div>
          ))}
          {shownFiles.length > 800 && <div className="muted small pad8">…{shownFiles.length - 800} more (filter to narrow)</div>}
        </div>
        <div className="code-view">
          {!file && <div className="muted center pad8">No file selected.</div>}
          {file && (diffMode
            ? <DiffView current={file.content} previous={file.previous} />
            : <pre className="code-content">{file.content ?? '(binary or unreadable)'}</pre>)}
        </div>
      </div>
    </div>
  );
}

function DiffView({ current, previous }) {
  const parts = useMemo(() => diffLines(previous ?? '', current ?? ''), [current, previous]);
  const unchanged = parts.every((p) => !p.added && !p.removed);
  if (unchanged) return <div className="muted center pad8">No changes to this file at this snapshot (vs. its previous version).</div>;
  return (
    <pre className="code-content diff">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? 'diff-add' : p.removed ? 'diff-del' : 'diff-ctx'}>
          {compressContext(p, i, parts.length)}
        </span>
      ))}
    </pre>
  );
}

// Show full added/removed hunks; trim long unchanged runs to 3 lines of context.
function compressContext(part, idx, total) {
  if (part.added || part.removed) return part.value;
  const lines = part.value.split('\n');
  if (lines.length <= 8) return part.value;
  const head = idx === 0 ? [] : lines.slice(0, 3);
  const tail = idx === total - 1 ? [] : lines.slice(-4);
  return [...head, `··· ${lines.length - head.length - tail.length} unchanged lines ···`, ...tail].join('\n');
}
