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

// The Memory analytics section (CHI-385 parity, ported from Varde's Memory
// page): four metric lanes grouped by windowing semantics (ACTIVITY follows the
// window, STATE is the last scan) plus a searchable notes browser. Rendered in
// Chronicle's own primitives (.card/.rank/.tbl/InfoTip) since this app has no
// utility CSS. All data is pre-computed server-side and read through lanes.ts.

/** A note reference the browser/tables hand back to the page's inspector. */
export interface NoteRef { id?: string; path?: string; name: string; kind?: string }

/** Freshness bucket fills, young to old, on a sequential violet ramp (the read
 * Chi tuned in Varde: age is legible by hue as well as length). */
const AGE_BUCKET_COLORS = ['#c9b4ec', '#9c7bd4', '#7d64ab', '#5c5670', '#494a55'];

function NoteName({ name, path }: { name: string; path?: string }) {
  return (
    <>
      {name}
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

function GroupLine({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="mem-group" data-group-line={label.toLowerCase()}>
      <span className="eyebrow">{label}</span>
      <span className="rule" aria-hidden="true" />
      <span className="gmeta">{meta}</span>
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
  usage, range, totalNotes, onSeeAll,
}: { usage: UsageLane; range: RangeKey; totalNotes: number; onSeeAll: () => void }) {
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
        </>
      )}
    </LaneCard>
  );
}

// --- Growth -------------------------------------------------------------------

function GrowthLaneView({ growth, range }: { growth: GrowthLane; range: RangeKey }) {
  const maxBirths = Math.max(1, ...growth.series.map((p) => p.births));
  return (
    <LaneCard title={t('Growth')} meta={rangeWord(range)} tip={<InfoTip def="memory.growth" />}>
      {growth.births == null ? (
        <div className="muted small">{t('Not measured yet. Re-run an aggregate to read note creation times.')}</div>
      ) : (
        <>
          <div className="lane-big">
            +{fmtInt(growth.births)}
            <span className="u">{t('notes in')} {rangeWord(range)}</span>
          </div>
          {growth.series.length >= 2 ? (
            <div className="growth-bars" data-growth-bars aria-hidden="true">
              {growth.series.map((p) => (
                <i key={p.day} className={p.births > 0 ? '' : 'zero'}
                  title={`${p.day}: +${p.births}`}
                  style={p.births > 0 ? { height: `${Math.max(8, (p.births / maxBirths) * 100)}%` } : undefined} />
              ))}
            </div>
          ) : null}
          <div className="lane-foot" data-growth-axis>
            {t('births per day · living base')} <span className="num">{fmtInt(growth.base ?? 0)}</span>
            {' · '}
            {growth.deletions
              ? `${fmtInt(growth.deletions.total)} ${t('deletions · tracked from')} ${growth.deletions.since}`
              : t('deletion tracking starts after the next aggregate')}
          </div>
        </>
      )}
    </LaneCard>
  );
}

// --- Freshness (rot) ----------------------------------------------------------

function FreshnessLaneView({ rot, stateMeta }: { rot: RotLane; stateMeta: string }) {
  const maxCount = Math.max(1, ...rot.buckets.map((b) => b.count));
  const freshPct = rot.measured > 0 ? Math.round((rot.fresh / rot.measured) * 100) : null;
  return (
    <LaneCard title={t('Freshness')} meta={stateMeta} tip={<InfoTip def="memory.freshness" />}>
      {rot.thresholdDays == null ? (
        <div className="muted small">{t('Not measured yet. Re-run an aggregate to build the age distribution.')}</div>
      ) : (
        <>
          <div className="lane-big">
            {freshPct != null ? `${freshPct}%` : '—'}<span className="u">{t('fresh')}</span>
            <span className="sub">
              <span className={rot.oldCount > 0 ? '' : ''} style={{ color: rot.oldCount > 0 ? 'var(--warn)' : 'var(--ok)' }}>{fmtInt(rot.oldCount)} {t('stale')}</span>
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
          {rot.oldest.length ? (
            <>
              <div className="lane-blockhead"><span>{t('Oldest stale')}</span><span>{t('age')}</span></div>
              <table className="tbl">
                <tbody>
                  {rot.oldest.slice(0, 4).map((n) => (
                    <tr key={n.path ?? n.name}><td><NoteName name={n.name} path={n.path} /></td>
                      <td><span style={{ color: 'var(--warn)' }}>{fmtInt(n.ageDays)}d {t('stale')}</span></td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      )}
    </LaneCard>
  );
}

// --- Connectivity -------------------------------------------------------------

function ConnectivityLaneView({
  connectivity, range, stateMeta, allByLinksCount, onSeeAll,
}: {
  connectivity: ConnectivityLane; range: RangeKey; stateMeta: string;
  allByLinksCount: number; onSeeAll: (preset: BrowserPreset) => void;
}) {
  const deltaWindow = range === '7d' || range === '30d' || range === '90d' ? `Δ ${range}` : null;
  return (
    <LaneCard title={t('Connectivity')} meta={stateMeta} tip={<InfoTip def="memory.orphan" />}>
      <div className="lane-big">
        {fmtInt(connectivity.orphans)}<span className="u">{t('orphans')}</span>
        <span className="sub">
          <span className="num" style={{ color: 'var(--ink)' }}>{fmtInt(connectivity.unlinked)}</span> {t('unlinked')} ·{' '}
          {connectivity.deadLinks > 0
            ? <span style={{ color: 'var(--warn)' }}>{fmtInt(connectivity.deadLinks)} {t('dead links')}</span>
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
      {connectivity.deltaAccruesFrom ? (
        <div className="lane-foot">{t('link history accrues from')} {connectivity.deltaAccruesFrom}</div>
      ) : null}

      <div className="lane-blockhead" data-connectivity-block="orphans">
        <span>{t('Orphans')}</span><span>{`0 ${t('links')} · 0 ${t('touches in')} ${rangeWord(range)}`}</span>
      </div>
      {connectivity.orphanList.length ? (
        <>
          <table className="tbl">
            <tbody>
              {connectivity.orphanList.slice(0, 3).map((o) => (
                <tr key={o.path ?? o.name}><td><NoteName name={o.name} path={o.path} /></td>
                  <td className="muted">{o.kind}</td></tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="lane-see" onClick={() => onSeeAll('orphans')}>
            {t('all {n} orphans →').replace('{n}', String(connectivity.orphans))}
          </button>
        </>
      ) : (
        <div className="muted small" style={{ marginTop: 4 }}>
          {t('No living note is orphaned in this window.')}
        </div>
      )}
    </LaneCard>
  );
}

// --- Notes browser ------------------------------------------------------------

type BrowserPreset = 'touched' | 'connected' | 'orphans';

const BROWSER_PRESETS: { key: BrowserPreset; label: string; value: string }[] = [
  { key: 'touched', label: 'Touched', value: 'touches' },
  { key: 'connected', label: 'Most connected', value: 'links' },
  { key: 'orphans', label: 'Orphans', value: 'kind' },
];

interface AllByLinksRow { id: string; name: string; path?: string; kind?: string; links: number }

function NotesBrowser({
  preset, onPreset, usage, connectivity, allByLinks, range, onInspect,
}: {
  preset: BrowserPreset; onPreset: (p: BrowserPreset) => void;
  usage: UsageLane; connectivity: ConnectivityLane; allByLinks: AllByLinksRow[];
  range: RangeKey; onInspect: (ref: NoteRef) => void;
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
    return usage.touched.map((e) => ({ key: e.note, ref: { id: e.note, name: e.name, path: e.path, kind: e.kind }, name: e.name, path: e.path, kind: e.kind, value: fmtInt(e.count) }));
  }, [preset, usage.touched, connectivity.orphanList, allByLinks]);

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
    ? `${fmtInt(presetRows.length)} ${t('touched')} · ${rangeWord(range)} · transcript ${fmtInt(usage.totals.transcript)} · wikilink ${fmtInt(usage.totals.wikilink)} · briefing ${fmtInt(usage.totals.briefing)}`
    : preset === 'connected'
      ? `${fmtInt(presetRows.length)} ${t('by links · current state')}`
      : `${fmtInt(presetRows.length)} ${t('orphans')}`;

  return (
    <div className="card" data-notes-browser>
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
        <div className="nb-kinds" role="group" aria-label={t('Kind filter')}>
          <button type="button" aria-pressed={activeKind == null} className={activeKind == null ? 'on' : ''} onClick={() => setKind(null)}>{t('All')}</button>
          {kinds.map(([k]) => (
            <button key={k} type="button" aria-pressed={activeKind === k} className={activeKind === k ? 'on' : ''}
              onClick={() => setKind((cur) => (cur === k ? null : k))}>{k}</button>
          ))}
        </div>
      </div>
      <div className="nb-scroll" data-notes-browser-list>
        {rows.length === 0 ? (
          <div className="muted small">
            {presetRows.length === 0
              ? (preset === 'orphans' ? t('No living note is orphaned in this window.')
                : preset === 'touched' ? t('No note was touched in this window by any channel.')
                  : t('No note carries links yet.'))
              : t('No note matches the filter.')}
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>{t('note')}</th><th>{t(valueHeader)}</th></tr></thead>
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
  slice, range, onInspect,
}: { slice: MemorySliceView; range: RangeKey; onInspect: (ref: NoteRef) => void }) {
  const cutoff = useMemo(() => windowCutoff(range), [range]);
  const usage = useMemo(() => usageLane(slice, cutoff), [slice, cutoff]);
  const growth = useMemo(() => growthLane(slice, cutoff), [slice, cutoff]);
  const rot = useMemo(() => rotLane(slice), [slice]);
  const connectivity = useMemo(() => connectivityLane(slice, cutoff, range), [slice, cutoff, range]);

  // Full most-connected ranking for the browser's "connected" preset.
  const allByLinks = useMemo<AllByLinksRow[]>(() => {
    const degree = new Map<string, number>();
    for (const l of slice.links) {
      const s = linkEnd(l.source); const tgt = linkEnd(l.target);
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
    }
    return slice.nodes
      .filter((n) => (degree.get(n.id) ?? 0) > 0)
      .map((n) => ({ id: n.id, name: n.name, path: n.path, kind: n.kind, links: degree.get(n.id) ?? 0 }))
      .sort((a, b) => b.links - a.links || a.name.localeCompare(b.name));
  }, [slice.nodes, slice.links]);

  const [preset, setPreset] = useState<BrowserPreset>('touched');
  const stateMeta = `${t('current state')}`;

  return (
    <div data-memory-analytics>
      <GroupLine label={t('Activity')} meta={`${t('follows the window')} · ${rangeWord(range)}`} />
      <div className="mem-lanes">
        <UsageLaneView usage={usage} range={range} totalNotes={slice.stats.totalNotes} onSeeAll={() => setPreset('touched')} />
        <GrowthLaneView growth={growth} range={range} />
      </div>

      <GroupLine label={t('State')} meta={stateMeta} />
      <div className="mem-lanes">
        <FreshnessLaneView rot={rot} stateMeta={stateMeta} />
        <ConnectivityLaneView connectivity={connectivity} range={range} stateMeta={stateMeta}
          allByLinksCount={allByLinks.length} onSeeAll={setPreset} />
      </div>

      <div style={{ marginTop: 'var(--gap-3)' }}>
        <NotesBrowser preset={preset} onPreset={setPreset} usage={usage} connectivity={connectivity}
          allByLinks={allByLinks} range={range} onInspect={onInspect} />
      </div>
    </div>
  );
}
