import { useEffect, useState } from 'react';
import { api } from './api.js';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';

const POLL_MS = 15000;

export interface SyncStatusText {
  text: string;
  running: boolean;
  failed: boolean;
  // Manual trigger: POSTs /api/autosync/run then immediately re-polls status.
  // Rendered in the topbar so "synced Xm ago" is clickable from
  // every page, in addition to the existing invisible background sync.
  runNow: () => void;
}

// Polls GET /api/autosync/status and formats it as passive rail-header text
// ("synced 32s ago" / "syncing…" / "sync failed 5m ago" / "never synced").
// Originally read-only per the Phase 5 "invisible sync" decision (5a's ⇧⌘U +
// per-project "Sync Update" were the power-user escape hatches); Task 17 adds
// a click-to-sync-now affordance in the topbar on top of that.
export function useSyncStatus(): SyncStatusText {
  const [state, setState] = useState<Omit<SyncStatusText, 'runNow'>>({ text: t('never synced'), running: false, failed: false });

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const s = await api.autosyncStatus();
        if (cancelled) return;
        const failed = !s.running && s.lastResult != null && s.lastResult.ok === false;
        let text: string;
        if (s.running) {
          text = t('syncing…');
        } else if (failed) {
          text = `${t('sync failed')} ${formatRelativeTime(s.lastRun)}`;
        } else {
          text = `${t('synced')} ${formatRelativeTime(s.lastRun)}`;
        }
        setState({
          text,
          running: s.running,
          failed,
        });
      } catch {
        // Leave the last-known text in place on a transient fetch failure.
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  function runNow() {
    setState((s) => ({ ...s, text: t('syncing…'), running: true }));
    api.runAutosync().finally(() => {
      api.autosyncStatus().then((s) => {
        const failed = !s.running && s.lastResult != null && s.lastResult.ok === false;
        setState({
          text: s.running ? t('syncing…') : failed ? `${t('sync failed')} ${formatRelativeTime(s.lastRun)}` : `${t('synced')} ${formatRelativeTime(s.lastRun)}`,
          running: s.running,
          failed,
        });
      }).catch(() => {});
    }).catch(() => {});
  }

  return { ...state, runNow };
}
