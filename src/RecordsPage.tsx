import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type HubRecordsResult, type RecordsLedgerRowView } from './api.js';
import { t } from './i18n.js';

// Records ops surface (CHI-324 2h): the append-only hub records via the
// records() adapter slice. A record-TYPE switcher whose only phase-2 type is
// Sessions (records/sessions.jsonl). Hidden from nav when the hub is absent;
// this page still fails soft if reached directly.
const PAGE = 40; // click-to-extend chunk

export default function RecordsPage() {
  const [data, setData] = useState<HubRecordsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const pageRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef(0);

  useEffect(() => {
    let alive = true;
    api.hubRecords()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(String((e as Error).message)); });
    return () => { alive = false; };
  }, []);

  // Infinite scroll: extend the visible window when the sentinel nears view,
  // instead of a click-to-extend button. Root is the .page scroll container
  // (the window does not scroll here); moreRef gates it so it stops at the end.
  useEffect(() => {
    const el = sentinelRef.current;
    const root = pageRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && moreRef.current > 0) setShown((n) => n + PAGE);
    }, { root, rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [data]);

  const rows = data && !('hubPresent' in data) ? data.ledger.rows : [];
  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.repo) set.add(r.repo);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (repo && r.repo !== repo) return false;
      if (!q) return true;
      return r.focus.toLowerCase().includes(q) || r.sessionId.toLowerCase().includes(q) || (r.repo ?? '').toLowerCase().includes(q);
    });
  }, [rows, query, repo]);

  if (error) return <div className="page center muted">{t('Could not load records')}: {error}</div>;
  if (!data) return <div className="page center muted">{t('Loading…')}</div>;
  if ('hubPresent' in data) {
    return <div className="page center muted">{t('No hub connected. Run `chronicle hub set <path>` to unlock ops panels.')}</div>;
  }

  const visible = filtered.slice(0, shown);
  const more = filtered.length - visible.length;
  moreRef.current = more;

  return (
    <div className="page records-page" ref={pageRef}>
      <div className="eyebrow">{t('Records')}</div>

      {/* Record-type switcher (phase 2 ships only the Sessions type). */}
      <div className="tabs records-switcher" role="tablist">
        <button className="tab on" role="tab" aria-selected="true">{t('Sessions')}</button>
      </div>

      <div className="records-toolbar">
        <input
          className="records-filter" type="search" value={query}
          onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
          placeholder={t('Filter by focus, session, or repo…')}
        />
        {repos.length > 1 && (
          <div className="records-chips">
            <button className={`chip ${repo === null ? 'on' : ''}`} onClick={() => { setRepo(null); setShown(PAGE); }}>{t('all')}</button>
            {repos.map((rp) => (
              <button key={rp} className={`chip ${repo === rp ? 'on' : ''}`} onClick={() => { setRepo(rp); setShown(PAGE); }}>{rp}</button>
            ))}
          </div>
        )}
        <span className="records-count muted small">{filtered.length} {t('sessions')}</span>
      </div>

      {filtered.length === 0 ? (
        <p className="muted small records-empty">{t('No session records in this hub.')}</p>
      ) : (
        <table className="records-table">
          <thead>
            <tr>
              <th className="records-date">{t('Date')}</th>
              <th className="records-id">{t('Session ID')}</th>
              <th className="records-repo">{t('Repo')}</th>
              <th className="records-focus">{t('Focus')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => <Row key={`${r.sessionId}-${i}`} r={r} />)}
          </tbody>
        </table>
      )}

      {more > 0 && (
        <div className="records-more-sentinel" ref={sentinelRef} aria-hidden="true">
          <span className="muted small">{t('Loading')} {Math.min(PAGE, more)} {t('more')} · {more} {t('remaining')}</span>
        </div>
      )}
    </div>
  );
}

function Row({ r }: { r: RecordsLedgerRowView }) {
  const [copied, setCopied] = useState(false);
  // Click the id → copy the FULL id to the clipboard (Chi, 2026-08-26). No
  // navigation: the id is a copy affordance, not a link, so a non-imported id
  // is never a dead link. navigator.clipboard works on localhost (secure ctx).
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.sessionId); setCopied(true); setTimeout(() => setCopied(false), 1200); }
    catch { /* clipboard blocked (rare); no-op */ }
  };
  return (
    <tr className="records-row">
      <td className="records-date mono small">{r.date}</td>
      <td className="records-id">
        <button type="button" className={`records-idcopy mono ${copied ? 'copied' : ''}`}
          onClick={copy} title={t('Click to copy the full session id')}>
          {r.sessionId}
          <span className="records-copyhint">{copied ? t('copied') : t('copy')}</span>
        </button>
      </td>
      <td className="records-repo">{r.repo ? <span className="pill">{r.repo}</span> : <span className="muted">—</span>}</td>
      <td className="records-focus">{r.focus || <span className="muted">—</span>}</td>
    </tr>
  );
}
