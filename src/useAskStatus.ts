import { useCallback, useEffect, useState } from 'react';
import { api, type AskStatus } from './api.js';

// Whether the `∴ Ask` entry + /ask route are live. enabled requires
// the Settings toggle ON, the claude CLI present, and a non-demo console — all
// decided server-side. Fetched on mount; `refresh` lets the Settings toggle
// re-check without a reload. A failed fetch reads as disabled (fail-closed).
export function useAskStatus(): { status: AskStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<AskStatus | null>(null);
  const refresh = useCallback(() => {
    api.askStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, toggleOn: false, claudePresent: false, demo: false }));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { status, refresh };
}
