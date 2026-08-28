import { useMemo, useState } from 'react';
import { fmtInt } from '../../format.js';
import { t } from '../../i18n.js';
import InfoTip from '../../InfoTip.js';
import type { MemorySliceView } from '../../api.js';
import type { RangeKey } from '../../RangeBar.js';
import {
  windowCutoff, rangeWord, rotLane, usageLane, growthLane, connectivityLane,
  type RotLane, type UsageLane, type GrowthLane, type ConnectivityLane,
} from './lanes.js';

// The Memory analytics section (CHI-385 parity + fresh-eyes cleanup): a health
// verdict line, the Usage / Freshness / Connectivity lanes (Growth demoted to a
// verdict stat), and one Notes browser that owns every row list, including the
// dead-links and stale worklists. Rendered in Chronicle's own primitives
// (.card/.rank/.tbl/InfoTip) since this app has no utility CSS.

/** A note reference the browser/tables hand back to the page's inspector. */
export interface NoteRef { id?: string; path?: string; name: string; kind?: string }

/** The Notes-browser presets; also the jump targets the lanes + verdict use. */
export type BrowserPreset = 'touched' | 'connected' | 'orphans' | 'stale' | 'dead';

/** Freshness bucket fills, young to old, on a sequential violet ramp. */
const AGE_BUCKET_COLORS = ['#c9b4ec', '#9c7bd4', '#7d64ab', '#5c5670', '#494a55'];

/** Display name without a trailing "(...)" qualifier (e.g. "(archived
 * evidence)"): the canvas labels strip it too, and it clutters every table. */
export function shortName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '') || name;
}

function NoteName({ name, path }: { name: string; path?: string }) {
  return (
    <>
      {shortName(name)}
      {path ? <span className="lane-path" title={path}>{path}</span> : null}
    </>
  );
}

/** The canvas-adjacent metrics line: notes / links / decisions. */
export function MemoryMetrics({ slice }: { slice: MemorySliceView }) {
  const decisions = useMemo(
    () => slice.nodes.filter((n) => n.kind === 'decision').length,
    [slice.nodes],
  );
  return (
    <div className="mem-metrics" data-memory-metrics>
      <span className="num">{fmtInt(slice.stats.totalNotes)}</span> <span>{t('notes')} ·</span>
      <span className="num">{fmtInt(slice.stats.totalLinks)}</span> <span>{t('links')}</span>
      {decisions > 0 ? (
        <>
          <span>·</span>
          <span className="num">{fmtInt(decisions)}</span> <span>{t('decisions')}</span>
        </>
      ) : null}
    </div>
  );
}

/** The one-line health roll-up (fresh-eyes): freshness + the three repair
 * counts + net new, so the user knows if action is needed at a glance. The
 * three counts jump to the matching browser worklist. */
export function MemoryVerdict({
  rot, connectivity, growth, range, onJump,
}: {
  rot: RotLane; connectivity: ConnectivityLane; growth: GrowthLane;
  range: RangeKey; onJump: (p: BrowserPreset) => void;
}) {
  const freshPct = rot.measured > 0 ? Math.round((rot.fresh / rot.measured) * 100) : null;
  const jump = (p: BrowserPreset, warn: boolean, label: React.ReactNode) => (
    <button type="button" className={`mem-verdict-stat${warn ? ' warn' : ''}`} onClick={() => onJump(p)}>{label}</button>
  );
  return (
    <div className="mem-verdict" data-memory-verdict>
      {freshPct != null ? <span className="mem-verdict-stat"><span className="num">{freshPct}%</span> {t('fresh')}</span> : null}
      {jump('stale', rot.oldCount > 0, <><span className="num">{fmtInt(rot.oldCount)}</span> {t('stale')}</>)}
      {jump('orphans', connectivity.orphans > 0, <><span className="num">{fmtInt(connectivity.orphans)}</span> {t('orphaned')}</>)}
      {jump('dead', connectivity.deadLinks > 0, <><span className="num">{fmtInt(connectivity.deadLinks)}</span> {t('dead links')}</>)}
      {growth.births != null ? <span className="mem-verdict-stat"><span className="num">+{fmtInt(growth.births)}</span> {t('new')} · {rangeWord(range)}</span> : null}
    </div>
  );
}

function LaneCard({
  title, tip, meta, children,
}: { title: string; tip: React.ReactNode; meta?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3>
        {title} {tip}
        {meta ? <span className="lbl" style={{ marginLeft: 'auto', textTransform: 'none', color: 'var(--ink-3)' }}>{meta}</span> : null}
      </h3>
      {children}
    </div>
  );
}

// --- Usage --------------------------------------------------------------------

function UsageLaneView({
  usage, range, totalNotes, growth, onSeeAll,
}: { usage: UsageLane; range: RangeKey; totalNotes: number; growth: GrowthLane; onSeeAll: () => void }) {
  const touches = usage.totals.transcript + usage.totals.wikilink + usage.totals.briefing;
  return (
    <LaneCard title={t('Usage')} meta={`${t('touches')} · ${rangeWord(range)}`}
      tip={<InfoTip def="memory.touches" />}>
      {usage.touched.length === 0 ? (
        <div className="muted small">{t('No note was touched in this window by any channel.')}</div>
      ) : (
        <>
          <div className="lane-big">
            {fmtInt(usage.touched.length)}
            <span className="sub">{t('of')} {fmtInt(totalNotes)} {t('notes touched')} · <span className="num" style={{ color: 'var(--ink)' }}>{fmtInt(touches)}</span> {t('touches')}</span>
          </div>
          <div className="lane-blockhead"><span>{t('Most touched')}</span><span>{t('touches')}</span></div>
          <table className="tbl">
            <tbody>
              {usage.touched.slice(0, 5).map((e) => (
                <tr key={e.note}><td><NoteName name={e.name} path={e.path} /></td><td>{fmtInt(e.count)}</td></tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="lane-see" onClick={onSeeAll}>
            {t('all {n} touched →').replace('{n}', String(usage.touched.length))}
          </button>
          {growth.births != null ? (
            <div className="lane-foot">
              <span className="num">+{fmtInt(growth.births)}</span> {t('new notes')} · {t('living base')} <span className="num">{fmtInt(growth.base ?? 0)}</span>
              {growth.deletions ? <> · <span className="num">{fmtInt(growth.deletions.total)}</span> {t('deleted since')} {growth.deletions.since}</> : null}
            </div>
          ) : null}
        </>
      )}
    </LaneCard>
  );
}

// --- Freshness (rot) ----------------------------------------------------------

function FreshnessLaneView({ rot, onSeeAll }: { rot: RotLane; onSeeAll: () => void }) {
  const maxCount = Math.max(1, ...rot.buckets.map((b) => b.count));
  const freshPct = rot.measured > 0 ? Math.round((rot.fresh / rot.measured) * 100) : null;
  return (
    <LaneCard title={t('Freshness')} meta={t('current state')} tip={<InfoTip def="memory.freshness" />}>
      {rot.thresholdDays == null ? (
        <div className="muted small">{t('Not measured yet. Re-run an aggregate to build the age distribution.')}</div>
      ) : (
        <>
          <div className="lane-big">
            {freshPct != null ? `${freshPct}%` : '—'}<span className="u">{t('fresh')}</span>
            <span className="sub">
              <span style={{ color: rot.oldCount > 0 ? 'var(--warn)' : 'var(--ok)' }}>{fmtInt(rot.oldCount)} {t('stale')}</span>
              {' '}{t('of')} {fmtInt(rot.measured)} {t('living notes')}
              {rot.flagged.length ? <> · {fmtInt(rot.flagged.length)} {t('rotting')}</> : null}
            </span>
          </div>
          <div style={{ marginTop: 10 }}>
            {rot.buckets.map((b, i) => (
              <div className="rank nopct" key={b.label}>
                <span className="n">{b.label}</span>
                <div className="track"><i style={{ width: `${Math.max(b.count > 0 ? 2 : 0, (b.count / maxCount) * 100)}%`, background: AGE_BUCKET_COLORS[i] ?? AGE_BUCKET_COLORS[AGE_BUCKET_COLORS.length - 1] }} /></div>
                <span className="v" style={b.count === 0 ? { color: 'var(--ink-3)' } : undefined}>{fmtInt(b.count)}</span>
              </div>
            ))}
          </div>
          <div className="lane-foot">
            {t('age since last edit · stale past')} {fmtInt(rot.thresholdDays)}d{rot.oldest.length === 0 ? ` · ${t('none stale')}` : ''}
          </div>
          {rot.oldCount > 0 ? (
            <button type="button" className="lane-see" onClick={onSeeAll}>{t('all {n} stale →').replace('{n}', String(rot.oldCount))}</button>
          ) : null}
        </>
      )}
    </LaneCard>
  );
}

// --- Connectivity -------------------------------------------------------------

function ConnectivityLaneView({
  connectivity, range, allByLinksCount, onSeeAll,
}: {
  connectivity: ConnectivityLane; range: RangeKey;
  allByLinksCount: number; onSeeAll: (preset: BrowserPreset) => void;
}) {
  const deltaWindow = range === '7d' || range === '30d' || range === '90d' ? `Δ ${range}` : null;
  return (
    <LaneCard title={t('Connectivity')} meta={t('current state')} tip={<InfoTip def="memory.orphan" />}>
      <div className="lane-big">
        {fmtInt(connectivity.orphans)}<span className="u">{t('orphans')}</span>
        <span className="sub">
          <span className="num" style={{ color: 'var(--ink)' }}>{fmtInt(connectivity.unlinked)}</span> {t('unlinked')} ·{' '}
          {connectivity.deadLinks > 0
            ? <button type="button" className="lane-inline-see" onClick={() => onSeeAll('dead')}><span style={{ color: 'var(--warn)' }}>{fmtInt(connectivity.deadLinks)} {t('dead links')} →</span></button>
            : t('no dead links')}
        </span>
      </div>

      <div className="lane-blockhead" data-connectivity-block="most-connected">
        <span>{t('Most connected')}</span><span>{deltaWindow ? `${t('links')} · ${deltaWindow}` : t('links')}</span>
      </div>
      <table className="tbl">
        <tbody>
          {connectivity.hubs.slice(0, 3).map((h) => (
            <tr key={h.path ?? h.name}>
              <td><NoteName name={h.name} path={h.path} /></td>
              <td>{fmtInt(h.links)}{h.delta != null && h.delta !== 0
                ? <span className={`lane-delta${h.delta < 0 ? ' down' : ''}`}>{h.delta > 0 ? `+${h.delta}` : h.delta}</span>
                : null}</td>
            </tr>
          ))}
          {!connectivity.hubs.length ? <tr><td className="muted">{t('No linked notes yet.')}</td><td /></tr> : null}
        </tbody>
      </table>
      <button type="button" className="lane-see" onClick={() => onSeeAll('connected')}>
        {t('all {n} by links →').replace('{n}', String(allByLinksCount))}
      </button>
      {connectivity.orphans > 0 ? (
        <button type="button" className="lane-see" onClick={() => onSeeAll('orphans')}>{t('all {n} orphans →').replace('{n}', String(connectivity.orphans))}</button>
      ) : null}
      {connectivity.deltaAccruesFrom ? (
        <div className="lane-foot">{t('link history accrues from')} {connectivity.deltaAccruesFrom}</div>
      ) : null}
    </LaneCard>
  );
}

// --- Notes browser ------------------------------------------------------------

const BROWSER_PRESETS: { key: BrowserPreset; label: string; value: string }[] = [
  { key: 'touched', label: 'Touched', value: 'touches' },
  { key: 'connected', label: 'Most connected', value: 'links' },
  { key: 'stale', label: 'Stale', value: 'age' },
  { key: 'orphans', label: 'Orphans', value: 'kind' },
  { key: 'dead', label: 'Dead links', value: 'target' },
];

interface AllByLinksRow { id: string; name: string; path?: string; kind?: string; links: number }

function NotesBrowser({
  preset, onPreset, usage, connectivity, rot, allByLinks, range, onInspect, browserId,
}: {
  preset: BrowserPreset; onPreset: (p: BrowserPreset) => void;
  usage: UsageLane; connectivity: ConnectivityLane; rot: RotLane; allByLinks: AllByLinksRow[];
  range: RangeKey; onInspect: (ref: NoteRef) => void; browserId: string;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string | null>(null);

  interface Row { key: string; ref: NoteRef; name: string; path?: string; kind?: string; value: React.ReactNode }
  const presetRows = useMemo<Row[]>(() => {
    if (preset === 'connected') {
      return allByLinks.map((r) => ({ key: r.id, ref: { id: r.id, name: r.name, path: r.path, kind: r.kind }, name: r.name, path: r.path, kind: r.kind, value: fmtInt(r.links) }));
    }
    if (preset === 'orphans') {
      return [...connectivity.orphanList]
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
        .map((r) => ({ key: r.path ?? r.name, ref: { path: r.path, name: r.name, kind: r.kind }, name: r.name, path: r.path, kind: r.kind, value: <span className="muted">{r.kind}</span> }));
    }
    if (preset === 'stale') {
      return rot.oldest.map((r) => ({ key: r.path ?? r.name, ref: { path: r.path, name: r.name, kind: r.kind }, name: r.name, path: r.path, kind: r.kind, value: <span style={{ color: 'var(--warn)' }}>{fmtInt(r.ageDays)}d</span> }));
    }
    if (preset === 'dead') {
      return connectivity.deadLinkList.map((d, i) => ({ key: `${d.source}-${d.target}-${i}`, ref: { path: d.sourcePath, name: d.source }, name: d.source, path: d.sourcePath, value: <span className="muted">[[{d.target}]]</span> }));
    }
    return usage.touched.map((e) => ({ key: e.note, ref: { id: e.note, name: e.name, path: e.path, kind: e.kind }, name: e.name, path: e.path, kind: e.kind, value: fmtInt(e.count) }));
  }, [preset, usage.touched, connectivity.orphanList, connectivity.deadLinkList, rot.oldest, allByLinks]);

  const kinds = useMemo(() => {
    const tally = new Map<string, number>();
    for (const r of presetRows) if (r.kind) tally.set(r.kind, (tally.get(r.kind) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [presetRows]);
  const activeKind = kind != null && kinds.some(([k]) => k === kind) ? kind : null;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return presetRows.filter((r) =>
      (activeKind == null || r.kind === activeKind) &&
      (!q || r.name.toLowerCase().includes(q) || (r.path ?? '').toLowerCase().includes(q)));
  }, [presetRows, query, activeKind]);

  const valueHeader = BROWSER_PRESETS.find((p) => p.key === preset)?.value ?? '';
  const meta = preset === 'touched'
    ? `${fmtInt(presetRows.length)} ${t('touched')} · ${rangeWord(range)}`
    : preset === 'connected' ? `${fmtInt(presetRows.length)} ${t('by links')}`
      : preset === 'stale' ? `${fmtInt(presetRows.length)} ${t('stale')}`
        : preset === 'dead' ? `${fmtInt(presetRows.length)} ${t('dead links')}`
          : `${fmtInt(presetRows.length)} ${t('orphans')}`;

  return (
    <div className="card" id={browserId} data-notes-browser>
      <h3>{t('Notes browser')} <InfoTip def="memory.notes-browser" />
        <span className="lbl" style={{ marginLeft: 'auto', textTransform: 'none', color: 'var(--ink-3)' }}>{meta}</span>
      </h3>
      <div className="nb-controls">
        <div className="nb-seg" role="group" aria-label={t('Browser preset')}>
          {BROWSER_PRESETS.map((p) => (
            <button key={p.key} type="button" data-browser-preset={p.key} aria-pressed={preset === p.key}
              className={preset === p.key ? 'on' : ''} onClick={() => onPreset(p.key)}>{t(p.label)}</button>
          ))}
        </div>
        <input className="nb-filter" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t('filter notes')} aria-label={t('Filter notes')} />
        {kinds.length > 1 ? (
          <div className="nb-kinds" role="group" aria-label={t('Kind filter')}>
            <button type="button" aria-pressed={activeKind == null} className={activeKind == null ? 'on' : ''} onClick={() => setKind(null)}>{t('All')}</button>
            {kinds.map(([k]) => (
              <button key={k} type="button" aria-pressed={activeKind === k} className={activeKind === k ? 'on' : ''}
                onClick={() => setKind((cur) => (cur === k ? null : k))}>{k}</button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="nb-scroll" data-notes-browser-list>
        {rows.length === 0 ? (
          <div className="muted small">
            {presetRows.length === 0
              ? (preset === 'orphans' ? t('No living note is orphaned in this window.')
                : preset === 'touched' ? t('No note was touched in this window by any channel.')
                  : preset === 'stale' ? t('Nothing is stale past the threshold.')
                    : preset === 'dead' ? t('No dead links. Every wikilink resolves.')
                      : t('No note carries links yet.'))
              : t('No note matches the filter.')}
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>{preset === 'dead' ? t('source') : t('note')}</th><th>{t(valueHeader)}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="rowlink" onClick={() => onInspect(r.ref)}>
                  <td><NoteName name={r.name} path={r.path} /></td>
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// --- The section ---------------------------------------------------------------

const linkEnd = (end: unknown): string =>
  typeof end === 'object' && end !== null ? String((end as { id?: string }).id ?? '') : String(end);

export function MemoryAnalytics({
  slice, range, preset, onPreset, onInspect, browserId,
}: {
  slice: MemorySliceView; range: RangeKey;
  preset: BrowserPreset; onPreset: (p: BrowserPreset) => void;
  onInspect: (ref: NoteRef) => void; browserId: string;
}) {
  const cutoff = useMemo(() => windowCutoff(range), [range]);
  const usage = useMemo(() => usageLane(slice, cutoff), [slice, cutoff]);
  const growth = useMemo(() => growthLane(slice, cutoff), [slice, cutoff]);
  const rot = useMemo(() => rotLane(slice), [slice]);
  const connectivity = useMemo(() => connectivityLane(slice, cutoff, range), [slice, cutoff, range]);

  const allByLinks = useMemo<AllByLinksRow[]>(() => {
    const degree = new Map<string, number>();
    for (const l of slice.links) {
      const s = linkEnd(l.source); const tgt = linkEnd(l.target);
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
    }
    return slice.nodes
      // Living-only, matching the server's most-connected (CHI-385): the
      // "connected" browse is a living-knowledge read, not archived records.
      .filter((n) => n.tier === 'living' && (degree.get(n.id) ?? 0) > 0)
      .map((n) => ({ id: n.id, name: n.name, path: n.path, kind: n.kind, links: degree.get(n.id) ?? 0 }))
      .sort((a, b) => b.links - a.links || a.name.localeCompare(b.name));
  }, [slice.nodes, slice.links]);

  return (
    <div data-memory-analytics>
      <div className="mem-lanes mem-lanes-3">
        <UsageLaneView usage={usage} range={range} totalNotes={slice.stats.totalNotes} growth={growth} onSeeAll={() => onPreset('touched')} />
        <FreshnessLaneView rot={rot} onSeeAll={() => onPreset('stale')} />
        <ConnectivityLaneView connectivity={connectivity} range={range} allByLinksCount={allByLinks.length} onSeeAll={onPreset} />
      </div>
      <div style={{ marginTop: 'var(--gap-3)' }}>
        <NotesBrowser preset={preset} onPreset={onPreset} usage={usage} connectivity={connectivity}
          rot={rot} allByLinks={allByLinks} range={range} onInspect={onInspect} browserId={browserId} />
      </div>
    </div>
  );
}
