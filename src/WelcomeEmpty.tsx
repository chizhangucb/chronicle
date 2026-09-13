// The zero-data welcome screen, and the demo affordance inside it.
//
// Shared by the Insights home and the Projects page, so "import your first
// project" reads identically on both. It lives in its own module rather than
// in either page: a widget parked in a page file makes the other page import
// that page (issue #381).
import { useEffect, useState } from 'react';
import { api } from './api.ts';

export function WelcomeEmpty({ onImport }: { onImport: () => void }) {
  return (
    <div className="page center empty-state">
      <div className="empty-icon">◷</div>
      <h2>Welcome to Chronicle</h2>
      <p className="muted">Import your AI coding sessions and time-travel through how your code came to be.<br />
        Everything stays on this machine — local-first, offline, read-only on your logs.</p>
      <button className="btn primary lg" onClick={onImport}>Import your first project</button>
      <DemoOffer />
    </div>
  );
}

// The demo affordance. A zero-data operator who runs the plain command
// otherwise has no way to learn demo mode exists: it would be discoverable only
// from --help or the README, which is exactly the audience least likely to read
// either. This is the whole reason the feature was asked for.
//
// It renders a BUTTON only when the server says it can restart itself (the CLI
// published a relaunch capability); under `npm run dev` there is nothing to
// relaunch, so it shows the command to copy instead. An affordance that does
// nothing when clicked would be worse than none.
function DemoOffer() {
  const [status, setStatus] = useState<{ demo: boolean; available: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => { api.demoStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  if (!status || status.demo) return null;

  if (!status.available) {
    return (
      <p className="muted small demo-offer">
        Want to see the product first? <code>npx chronicle-cli --demo</code>
      </p>
    );
  }
  return (
    <div className="demo-offer">
      <button
        type="button"
        className="btn"
        disabled={starting}
        onClick={async () => {
          setStarting(true);
          try {
            await api.demoStart();
            // The server restarts itself on the same port; poll until it
            // answers again, then reload into the demo console.
            const deadline = Date.now() + 60_000;
            const poll = setInterval(async () => {
              try {
                const s = await api.demoStatus();
                if (s.demo) { clearInterval(poll); window.location.reload(); return; }
              } catch { /* still restarting */ }
              if (Date.now() > deadline) { clearInterval(poll); setStarting(false); }
            }, 1000);
          } catch { setStarting(false); }
        }}
      >
        {starting ? 'Building the demo…' : 'Explore with sample data'}
      </button>
      <span className="muted small">A synthetic console, so you can see every surface before importing anything. Your own data is untouched.</span>
    </div>
  );
}
