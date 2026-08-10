import React, { useState, useEffect, useRef } from 'react';
import { api } from './api.js';
import { t } from './i18n.js';
import { sessionDisplayName } from './ProjectDetail.jsx';

// Global search palette (⌘K): All/Code/Chat scope, time + project
// filters, "Recent Access" when empty. Server does a LIKE scan grouped per session.

interface SearchScope {
  key: 'all' | 'code' | 'chat';
  label: string;
  icon: string;
}
const SEARCH_SCOPES: SearchScope[] = [
  { key: 'all', label: 'All', icon: '≡' },
  { key: 'code', label: 'Code', icon: '</>' },
  { key: 'chat', label: 'Chat', icon: '💬' },
];

interface SearchRange {
  key: string;
  label: string;
}
const SEARCH_RANGES: SearchRange[] = [
  { key: '', label: 'All Time' },
  { key: '7', label: '7 Days' },
  { key: '30', label: '30 Days' },
  { key: '365', label: '1 Year' },
];

// A project as listed by GET /api/projects, for the project filter select.
interface SearchProject {
  id: number;
  name: string;
}

// One result row (server/routes/search.ts SessionResult, plus the "Recent
// Access" shape when the query is empty — same fields, matchCount forced 0).
interface SearchResult {
  id: string;
  project_id: number;
  source: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
  project_name: string;
  matchCount: number;
  snippet: string;
  ts: string | null;
}

interface SearchData {
  recent: boolean;
  results: SearchResult[];
}

function relTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Number(new Date(ts))) / 1000);
  if (s < 60) return t('just now');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${t(m === 1 ? 'minute ago' : 'minutes ago')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${t(h === 1 ? 'hour ago' : 'hours ago')}`;
  const d = Math.floor(h / 24);
  return d === 1 ? t('1 day ago') : `${d} ${t('days ago')}`;
}

function searchHighlight(text: string, q: string): React.ReactNode {
  if (!text || !q) return text;
  const lower = text.toLowerCase(), needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0, idx;
  while ((idx = lower.indexOf(needle, i)) !== -1 && parts.length < 40) {
    parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

export interface SearchModalProps {
  onClose: () => void;
  onOpen: (sessionId: string, projectId: number) => void;
}

export default function SearchModal({ onClose, onOpen }: SearchModalProps) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState<SearchScope['key']>('all');
  const [days, setDays] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<SearchProject[]>([]);
  const [data, setData] = useState<SearchData>({ recent: true, results: [] });
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); api.projects().then(setProjects).catch(() => {}); }, []);
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 220); return () => clearTimeout(id); }, [q]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const params: Record<string, string> = { q: debounced, scope };
    if (days) params.days = days;
    if (projectId) params.project = projectId;
    api.search(params).then((d: SearchData) => { if (!stale) { setData(d); setActive(0); } })
      .catch(() => { if (!stale) setData({ recent: !debounced, results: [] }); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [debounced, scope, days, projectId]);

  const results = data.results || [];
  function open(r: SearchResult | undefined) { if (r) onOpen(r.id, r.project_id); }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); open(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="search-input-row">
          <span className="search-mag">🔍</span>
          <input ref={inputRef} className="search-input" placeholder={t('Search session content…')}
            value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="kbd">⌘K</span>
          <button className="btn ghost tiny" onClick={onClose}>✕</button>
        </div>
        <div className="search-filters">
          <span className="search-tabs">
            {SEARCH_SCOPES.map((s) => (
              <button key={s.key} className={`chip ${scope === s.key ? 'on' : ''}`} onClick={() => setScope(s.key)}>
                <span className="search-tab-icon">{s.icon}</span> {t(s.label)}
              </button>
            ))}
          </span>
          <span className="search-selects">
            <select className="chip range-select" value={days} onChange={(e) => setDays(e.target.value)}>
              {SEARCH_RANGES.map((r) => <option key={r.key} value={r.key}>📅 {t(r.label)}</option>)}
            </select>
            <select className="chip range-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">📁 {t('All Projects')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </span>
        </div>
        <div className="search-results" ref={listRef}>
          {data.recent && <div className="search-section muted small">{t('Recent Access')}</div>}
          {results.map((r, i) => (
            <button key={r.id} data-idx={i} className={`search-row ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)} onClick={() => open(r)}>
              <span className="search-row-clock">🕘</span>
              <span className="search-row-body">
                <span className="search-row-title">
                  <span className="search-row-project">{r.project_name}</span>
                  <span className="search-row-sep">/</span>
                  <span className="search-row-name">{sessionDisplayName(r)}</span>
                </span>
                {r.snippet && <span className="search-row-snippet muted small">{searchHighlight(r.snippet, debounced)}</span>}
              </span>
              <span className="search-row-meta muted small">
                {r.matchCount > 0 && <span className="search-row-count">{r.matchCount} {t(r.matchCount === 1 ? 'match' : 'matches')}</span>}
                <span>{relTime(r.ts)}</span>
              </span>
            </button>
          ))}
          {!loading && !results.length && (
            <div className="muted small pad8 center">{t('No results found')}</div>
          )}
        </div>
        <div className="search-footer muted small">
          <span>↑ ↓ {t('Navigate')}</span><span>↵ {t('Select')}</span><span>Esc {t('Close')}</span>
        </div>
      </div>
    </div>
  );
}
