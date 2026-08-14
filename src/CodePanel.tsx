import React, { useEffect, useMemo, useState } from 'react';
import { diffLines, type Change } from 'diff';
import { api, type GitTreeResult, type GitFileResult } from './api.js';

// A commit as returned by server/git.ts (commitAt/commitsBetween) — the
// message-to-snapshot mapping SessionView passes down as `commit`.
export interface Commit {
  hash: string;
  date: string;
  subject: string;
  beforeHistory?: boolean;
}

// The successful (non-`noRepo`) halves of api.ts's GitTreeResult/GitFileResult
// unions — what this component actually stores once a `noRepo` response has
// been narrowed away below.
interface GitTree {
  files: string[];
  changed: string[];
}

interface GitFile {
  content: string | null;
  previous: string | null;
  prevCommit: string | null;
  changedInCommit: boolean;
}

export interface CodePanelProps {
  projectId: number;
  commit: Commit | null;
  noRepo?: boolean;
  // True while SessionView's commit-fetch effect has an in-flight request
  // for the CURRENT selection (see the effect's comment in SessionView.tsx):
  // gitAt/gitTree/gitFile each block on a synchronous `git` subprocess, so a
  // snapshot change can take a perceptible moment on a big/busy repo. Shown
  // as a small spinner so the panel visibly acknowledges the click instead
  // of silently sitting on the previous snapshot.
  loading?: boolean;
}

// Code Snapshot Panel (FR-TT-3/4): file tree at the snapshot commit,
// file content, diff toggle (toolbar + `D`), changed-file highlighting.
export default function CodePanel({ projectId, commit, noRepo, loading }: CodePanelProps) {
  const [tree, setTree] = useState<GitTree>({ files: [], changed: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<GitFile | null>(null);
  const [diffMode, setDiffMode] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');

  useEffect(() => {
    if (!commit) return;
    let stale = false;
    api.gitTree(projectId, commit.hash).then((t: GitTreeResult) => {
      if (stale) return;
      if ('noRepo' in t) return; // no repo at this commit — the `noRepo` prop already drives the empty state
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
    api.gitFile(projectId, commit.hash, selectedPath).then((f: GitFileResult) => {
      if (stale) return;
      if ('noRepo' in f) { setFile(null); return; }
      setFile(f);
    }).catch(() => setFile(null));
    return () => { stale = true; };
  }, [projectId, commit?.hash, selectedPath]);

  // `D` toggles diff view (when not typing in an input)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey &&
          !['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement | null)?.tagName || '')) {
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
            <span className="commit-subject" title={commit.subject}>{commit.subject}</span>
            <span className="muted small commit-date">{new Date(commit.date).toLocaleString()}</span>
            {commit.beforeHistory && <span className="pill warn-pill">before first commit</span>}
            {loading && <span className="muted small spin" title="Loading this snapshot…">◌</span>}
          </span>
        ) : <span className="muted small">{loading ? 'Loading snapshot…' : 'Select a message to load its code snapshot'}</span>}
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

interface DiffViewProps {
  current: string | null;
  previous: string | null;
}

function DiffView({ current, previous }: DiffViewProps) {
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
function compressContext(part: Change, idx: number, total: number): string {
  if (part.added || part.removed) return part.value;
  const lines = part.value.split('\n');
  if (lines.length <= 8) return part.value;
  const head = idx === 0 ? [] : lines.slice(0, 3);
  const tail = idx === total - 1 ? [] : lines.slice(-4);
  return [...head, `··· ${lines.length - head.length - tail.length} unchanged lines ···`, ...tail].join('\n');
}
