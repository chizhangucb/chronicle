import { useEffect, useState } from 'react';
import { api, type HubStatus } from './api.js';

// Single source of truth for whether the ops surfaces exist (CHI-323). The
// sidebar gates every ops nav item on `present`, and each ops page uses it to
// distinguish absent from empty. Fetched once per mount; the hub is resolved
// per-request server-side, so a `chronicle hub set` + reload picks it up.
export function useHubStatus(): HubStatus | null {
  const [status, setStatus] = useState<HubStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api.hubStatus()
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { if (alive) setStatus({ present: false, mode: 'absent' }); });
    return () => { alive = false; };
  }, []);
  return status;
}
