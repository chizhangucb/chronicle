import { useEffect, useMemo, useState } from 'react';
import { api, type HubMemoryResult, type MemorySliceView } from './api.js';
import type { MemoryNode, MemoryLink } from './components/memory/types.ts';
import { clusterColors } from './components/memory/register.ts';
import { ScopePanel } from './components/memory/ScopePanel.tsx';
import { MemoryCanvasShell } from './components/memory/MemoryCanvasShell.tsx';
import { MemoryMetrics, MemoryAnalytics, type NoteRef } from './components/memory/MemoryLanes.tsx';
import { scopeLine, usageTouchMap, windowCutoff } from './components/memory/lanes.ts';
import RangeBar, { type RangeKey } from './RangeBar.tsx';
import { fmtInt } from './format.js';
import type { GateProposal } from './gate/gate.ts';
import { GateConfirmDialog } from './gate/GateConfirmDialog.tsx';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';

const endId = (end: MemoryLink['source']): string =>
  typeof end === 'object' && end !== null ? String((end as { id?: string }).id ?? '') : String(end);

// Memory ops surface (CHI-323 3e, analytics parity CHI-385): the V2 Nebula
// canvas with its lenses/legend/LINKS/FULL-LITE chrome, over the hub's markdown
// knowledge graph (titles/paths only, confidential pruned server-side), plus the
// four analytics lanes + notes browser + node inspector + scope. Hidden from nav
// when the hub is absent.
export default function MemoryPage() {
  const [data, setData] = useState<HubMemoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const [range, setRange] = useState<RangeKey>('30d');
  const [scopePanelOpen, setScopePanelOpen] = useState(false);
  const [proposal, setProposal] = useState<GateProposal | null>(null);
  const reducedMotion = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);

  async function load() {
    try { setData(await api.hubMemory()); }
    catch (e) { setError(String((e as Error).message)); }
  }
  useEffect(() => { load(); }, []);

  const slice = data && !('hubPresent' in data) ? (data as MemorySliceView) : null;
  // V2 Nebula colors by deterministic community (register.ts clusterColors).
  const clusterMap = useMemo(() => (slice ? clusterColors(slice.nodes, slice.links) : new Map<string, string>()), [slice]);
  // Windowed touches: the heat lens, the rot "unused" test, the orphan derivation.
  const touches = useMemo(() => (slice ? usageTouchMap(slice, windowCutoff(range)) : new Map<string, number>()), [slice, range]);

  if (error && !data) return <div className="page center muted">{t('Could not load the memory graph')}: {error}</div>;
  if (!data) return <div className="page center muted">{t('Loading…')}</div>;
  if ('hubPresent' in data) {
    return <div className="page center muted">{t('No hub connected. Run `chronicle hub set <path>` to unlock ops panels.')}</div>;
  }

  async function open(node: MemoryNode) {
    if (!node.path) return;
    try { await api.openFile(node.path); } catch (e) { setError(String((e as Error).message)); }
  }

  // A lane/browser row resolves to the same inspect panel as a canvas click.
  // Prefer the real node (it carries tier + mtime); synthesize a minimal one
  // only when the row names something not in the graph payload.
  function inspect(ref: NoteRef) {
    let node = ref.id ? slice!.nodes.find((n) => n.id === ref.id) : undefined;
    if (!node && ref.path) node = slice!.nodes.find((n) => n.path === ref.path);
    setSelected(node ?? {
      id: ref.id ?? ref.path ?? ref.name, name: ref.name, kind: ref.kind ?? 'note',
      tier: 'living', val: 0, color: '#5d655f', path: ref.path,
    });
  }

  // Inspect facts for the selected node: links in/out, dead links from it, and
  // its touches in the window (parity with Varde's inspect panel).
  const facts = selected ? (() => {
    let inbound = 0; let outbound = 0;
    for (const l of slice!.links) {
      if (endId(l.source) === selected.id) outbound++;
      if (endId(l.target) === selected.id) inbound++;
    }
    const dead = (slice!.connectivity?.deadLinks?.list ?? []).filter(
      (d) => (d.sourcePath && d.sourcePath === selected.path) || d.source === selected.name);
    return { inbound, outbound, dead, touches: touches.get(selected.id) ?? 0 };
  })() : null;

  const scope = scopeLine(slice);

  return (
    <div className="page memory-page">
      <div className="memory-head">
        <div>
          <div className="eyebrow">{t('Memory')}</div>
          <MemoryMetrics slice={slice!} />
          <div className="muted small" data-scope-line>
            {t('measuring')} <span className="num">{scope.living}</span> {t('living notes')}
            {scope.dirNames.length ? <> {t('across')} <span className="num">{scope.dirNames.join(', ')}</span>{scope.more > 0 ? `, +${scope.more} ${t('more')}` : ''}</> : null}
            {' · '}<span className="num">{slice!.stats.historical}</span> {t('records')}
          </div>
        </div>
        <div className="memory-head-right">
          <RangeBar value={range} onChange={setRange} />
        </div>
      </div>
      {error && <p className="gate-error">{error}</p>}

      <div className="memory-layout">
        <div>
          <MemoryCanvasShell
            nodes={slice!.nodes}
            links={slice!.links}
            clusterMap={clusterMap}
            touches={touches}
            range={range}
            capSuggested={slice!.stats.capSuggested}
            selectedId={selected?.id ?? null}
            onSelect={(n) => setSelected(n)}
            onOpen={open}
            reducedMotion={reducedMotion}
          />
        </div>

        <aside className="memory-side">
          {selected ? (
            <div className="memory-inspector">
              <div className="memory-node-name">{selected.name}</div>
              <div className="muted small">{selected.kind} · {selected.tier === 'historical' ? t('record') : t('living')}
                {selected.mtime ? <> · {t('updated')} {formatRelativeTime(selected.mtime)}</> : null}</div>
              {selected.path && <div className="muted small memory-node-path">{selected.path}</div>}
              {facts && (
                <div className="mem-inspect-facts muted small">
                  <div><span className="num">{fmtInt(facts.touches)}</span> {facts.touches === 1 ? t('touch') : t('touches')} · {range === 'all' ? t('all time') : range}</div>
                  <div><span className="num">{fmtInt(facts.inbound)}</span> {t('links in')} · <span className="num">{fmtInt(facts.outbound)}</span> {t('out')}</div>
                  <div>{facts.dead.length
                    ? <><span className="num" style={{ color: 'var(--warn)' }}>{fmtInt(facts.dead.length)}</span> {facts.dead.length === 1 ? t('dead link') : t('dead links')}</>
                    : t('no dead links from it')}</div>
                </div>
              )}
              {selected.path && <button type="button" className="btn tiny" onClick={() => open(selected)}>{t('Open note')}</button>}
            </div>
          ) : (
            <p className="muted small">{t('Click a node to inspect it; double-click to open the note.')}</p>
          )}
          <div className="memory-scope">
            <div className="eyebrow">{t('Scope')}</div>
            <div className="muted small">{t('living')}: {slice!.scope.tiers.living.join(', ') || '—'}</div>
            <div className="muted small">{t('historical')}: {slice!.scope.tiers.historical.join(', ') || '—'}</div>
            <div className="muted small">{t('excluded')}: {slice!.scope.tiers.excluded.join(', ') || '—'}</div>
            <div className="muted small">{t('rot threshold')}: {slice!.scope.rotDays}d</div>
            <button type="button" className="btn tiny" onClick={() => setScopePanelOpen(true)}>{t('Manage scope')}</button>
          </div>
        </aside>
      </div>

      <MemoryAnalytics slice={slice!} range={range} onInspect={inspect} />

      {scopePanelOpen && (
        <ScopePanel
          scope={slice!.scope}
          onClose={() => setScopePanelOpen(false)}
          onProposal={(p) => setProposal(p)}
          onError={(msg) => setError(msg)}
        />
      )}
      <GateConfirmDialog
        proposal={proposal}
        onSettled={(confirmed) => { setProposal(null); setScopePanelOpen(false); if (confirmed) load(); }}
      />
    </div>
  );
}
