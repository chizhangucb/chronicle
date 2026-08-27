import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
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

  useEffect(() => {
    let alive = true;
    api.hubRecords()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(String((e as Error).message)); });
    return () => { alive = false; };
  }, []);

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

  return (
    <div className="page records-page">
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
        <button className="window-btn records-more" onClick={() => setShown((n) => n + PAGE)}>
          {t('Show')} {Math.min(PAGE, more)} {t('more')} · {more} {t('remaining')}
        </button>
      )}
    </div>
  );
}

function Row({ r }: { r: RecordsLedgerRowView }) {
  return (
    <tr className="records-row">
      <td className="records-date mono small">{r.date}</td>
      {/* Imported session ids link into the session view; a bare id (no imported
          session) is a fast-follow that renders plain mono (see 2h notes). */}
      <td className="records-id"><Link className="records-idlink mono" href={`/session/${encodeURIComponent(r.sessionId)}`}>{r.sessionId}</Link></td>
      <td className="records-repo">{r.repo ? <span className="pill">{r.repo}</span> : <span className="muted">—</span>}</td>
      <td className="records-focus">{r.focus || <span className="muted">—</span>}</td>
    </tr>
  );
}
