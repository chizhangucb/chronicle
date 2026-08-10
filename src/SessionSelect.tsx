import React, { useEffect, useRef, useState } from 'react';
import * as Toast from '@radix-ui/react-toast';
import { api } from './api.js';
import { t } from './i18n.js';

// Shared session-level multi-select delete, mounted verbatim in BOTH the Home
// recent-sessions stream (HomePage) and the project session list
// (ProjectDetail) — see CLAUDE.md "Session multi-select delete (BOTH
// surfaces, one shared component)". Reuses the inline-confirm pattern from
// HomePage's project multi-select (never `window.confirm`, blocked in
// embedded/preview browsers).
//
// Delete tombstones each session server-side (server/db.ts); the "Undo" toast
// that follows just forgets the tombstone(s) and re-syncs the owning
// project(s) — the source log was never touched, so undo is a pure re-import.

export interface SelectableSession {
  id: string;
  source: string;
  project_id: number;
}

export interface DeletedEntry {
  id: string;
  source: string;
  projectId: number;
}

const UNDO_MS = 10000;

export interface UseSessionSelect {
  selectMode: boolean;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  enterSelect: () => void;
  Bar: React.ReactNode;
  Toast: React.ReactNode;
}

// `pendingUndo`: a delete performed elsewhere (e.g. the Overview single-session
// danger-zone delete, which navigates away immediately) that should surface the
// SAME undo toast here once this component mounts at the destination view —
// see OverviewMode's onDeleted / App's pendingUndo plumbing. Consumed once.
export function useSessionSelect(sessions: SelectableSession[], onRefresh: () => void, pendingUndo?: DeletedEntry | null): UseSessionSelect {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [undoEntries, setUndoEntries] = useState<DeletedEntry[] | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the last `pendingUndo` object processed (by reference) so a fresh
  // delete from the caller (a new object) re-triggers the toast even if an
  // earlier one was already consumed here, while re-renders with the same
  // reference don't loop.
  const lastPendingUndo = useRef<DeletedEntry | null | undefined>(null);

  useEffect(() => {
    if (!pendingUndo || pendingUndo === lastPendingUndo.current) return;
    lastPendingUndo.current = pendingUndo;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoEntries([pendingUndo]);
    undoTimer.current = setTimeout(() => setUndoEntries(null), UNDO_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUndo]);

  function exitSelect() { setSelectMode(false); setSelected(new Set()); setConfirming(false); }
  function enterSelect() { setSelectMode(true); }
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setConfirming(false);
  }

  async function deleteSelected() {
    if (deleting || !selected.size) return;
    setDeleting(true);
    const entries: DeletedEntry[] = [];
    try {
      for (const id of selected) {
        const s = sessions.find((x) => x.id === id);
        try {
          const r = await api.deleteSession(id);
          entries.push({ id, source: s?.source ?? r.source, projectId: s?.project_id ?? r.projectId });
        } catch {}
      }
      onRefresh();
      exitSelect();
      if (entries.length) {
        if (undoTimer.current) clearTimeout(undoTimer.current);
        setUndoEntries(entries);
        undoTimer.current = setTimeout(() => setUndoEntries(null), UNDO_MS);
      }
    } finally {
      setDeleting(false);
    }
  }

  async function undo() {
    if (!undoEntries) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    const entries = undoEntries;
    setUndoEntries(null);
    for (const e of entries) { try { await api.undoDeleteSession(e.source, e.id); } catch {} }
    const projectIds = [...new Set(entries.map((e) => e.projectId))];
    for (const pid of projectIds) { try { await api.syncProject(pid); } catch {} }
    onRefresh();
  }

  const allSelected = selected.size === sessions.length && sessions.length > 0;

  const Bar = selectMode ? (
    confirming ? (
      <>
        <span className="muted small">{t('Remove these sessions from Chronicle? Source logs are not touched — you can undo right after.')}</span>
        <button className="btn ghost" onClick={() => setConfirming(false)} disabled={deleting}>{t('Cancel')}</button>
        <button className="btn danger-btn" onClick={deleteSelected} disabled={deleting}>
          {deleting ? t('Removing…') : `🗑 ${t('Remove')} ${selected.size}`}
        </button>
      </>
    ) : (
      <>
        <span className="muted small">{selected.size} {t('selected')}</span>
        <button className="btn ghost" onClick={() => setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.id)))}>
          {allSelected ? t('Clear') : t('Select all')}
        </button>
        <button className="btn ghost" onClick={exitSelect}>{t('Cancel')}</button>
        <button className="btn danger-btn" disabled={!selected.size} onClick={() => setConfirming(true)}>
          🗑 {t('Remove')}{selected.size ? ` (${selected.size})` : ''}
        </button>
      </>
    )
  ) : (
    <button className="btn ghost" onClick={enterSelect}>☑ {t('Select')}</button>
  );

  const UndoToast = undoEntries ? (
    <Toast.Root className="update-toast" open
      onOpenChange={(o) => { if (!o) { if (undoTimer.current) clearTimeout(undoTimer.current); setUndoEntries(null); } }}>
      <div>
        <div className="update-toast-title">
          {undoEntries.length === 1 ? t('Session removed') : `${undoEntries.length} ${t('sessions removed')}`}
        </div>
        <div className="update-toast-sub">{t('From Chronicle only — source logs untouched.')}</div>
      </div>
      <Toast.Action asChild altText={t('Undo')}>
        <button className="btn primary" onClick={undo}>{t('Undo')}</button>
      </Toast.Action>
    </Toast.Root>
  ) : null;

  return { selectMode, isSelected: (id: string) => selected.has(id), toggle, enterSelect, Bar, Toast: UndoToast };
}
