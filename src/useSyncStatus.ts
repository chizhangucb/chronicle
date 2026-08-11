import { useEffect, useState } from 'react';
import { api } from './api.js';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';

const POLL_MS = 15000;

export interface SyncStatusText {
  text: string;
  running: boolean;
  failed: boolean;
}

// Polls GET /api/autosync/status and formats it as passive rail-header text
// ("synced 32s ago" / "syncing…" / "sync failed 5m ago" / "never synced") — no buttons, per the
// Phase 5 "invisible sync" decision (5a's ⇧⌘U + per-project "Sync Update"
// remain as the power-user escape hatches; this hook is read-only).
export function useSyncStatus(): SyncStatusText {
  const [state, setState] = useState<SyncStatusText>({ text: t('never synced'), running: false, failed: false });

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

  return state;
}
