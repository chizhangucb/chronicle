import { useEffect, useState } from 'react';
import { api } from './api.js';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';

const POLL_MS = 15000;

export interface SyncStatusText {
  text: string;
  running: boolean;
}

// Polls GET /api/autosync/status and formats it as passive rail-header text
// ("synced 32s ago" / "syncing…" / "never synced") — no buttons, per the
// Phase 5 "invisible sync" decision (5a's ⇧⌘U + per-project "Sync Update"
// remain as the power-user escape hatches; this hook is read-only).
export function useSyncStatus(): SyncStatusText {
  const [state, setState] = useState<SyncStatusText>({ text: t('never synced'), running: false });

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const s = await api.autosyncStatus();
        if (cancelled) return;
        setState({
          text: s.running ? t('syncing…') : `${t('synced')} ${formatRelativeTime(s.lastRun)}`,
          running: s.running,
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
