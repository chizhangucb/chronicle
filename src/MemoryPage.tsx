import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { api, type HubMemoryResult, type MemorySliceView } from './api.js';
import type { MemoryNode } from './components/memory/types.ts';
import { MEMORY_REGISTER, clusterColors, CLUSTER_PALETTE } from './components/memory/register.ts';
import { formatRelativeTime } from './relativeTime.js';
import { t } from './i18n.js';

// The three.js layer is heavy; lazy-load it so it never enters the entry chunk.
const MemoryGraph = lazy(() => import('./components/memory/MemoryGraph.tsx').then((m) => ({ default: m.MemoryGraph })));

// Memory ops surface (CHI-323 3e): the V2 Nebula canvas over the hub's markdown
// knowledge graph (titles/paths only, confidential pruned server-side), with a
// cluster legend, stats, a node inspector, and a scope readout. Hidden from nav
// when the hub is absent.
export default function MemoryPage() {
  const [data, setData] = useState<HubMemoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const reducedMotion = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []);

  useEffect(() => {
    let alive = true;
    api.hubMemory().then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setError(String((e as Error).message)); });
    return () => { alive = false; };
  }, []);

  // V2 Nebula colors by deterministic community (register.ts clusterColors).
  const slice = data && !('hubPresent' in data) ? (data as MemorySliceView) : null;
  const clusterMap = useMemo(() => (slice ? clusterColors(slice.nodes, slice.links) : new Map<string, string>()), [slice]);

  if (error && !data) return <div className="page center muted">{t('Could not load the memory graph')}: {error}</div>;
  if (!data) return <div className="page center muted">{t('Loading…')}</div>;
  if ('hubPresent' in data) {
    return <div className="page center muted">{t('No hub connected. Run `chronicle hub set <path>` to unlock ops panels.')}</div>;
  }

  const colorOf = (node: MemoryNode): string => clusterMap.get(node.id) ?? node.color ?? '#5d655f';
  const linkTintOf = (sourceId: string): string | null => clusterMap.get(sourceId) ?? null;

  async function open(node: MemoryNode) {
    if (!node.path) return;
    try { await api.openFile(node.path); } catch (e) { setError(String((e as Error).message)); }
  }

  const clusters = new Map<string, number>();
  for (const c of clusterMap.values()) clusters.set(c, (clusters.get(c) ?? 0) + 1);
  const topClusters = [...clusters.entries()].filter(([c]) => CLUSTER_PALETTE.includes(c)).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="page memory-page">
      <div className="memory-head">
        <div>
          <div className="eyebrow">{t('Memory')}</div>
          <p className="muted small">
            {slice!.stats.totalNotes} {t('notes')} · {slice!.stats.totalLinks} {t('links')} · {slice!.stats.living} {t('living')} · {slice!.stats.historical} {t('historical')}
          </p>
        </div>
        <div className="memory-legend">
          {topClusters.map(([color, n]) => (
            <span key={color} className="memory-legend-item"><span className="memory-swatch" style={{ background: color }} />{n}</span>
          ))}
          <span className="muted small">{t('communities')}</span>
        </div>
      </div>
      {error && <p className="gate-error">{error}</p>}

      <div className="memory-layout">
        <div className="memory-canvas-wrap">
          <Suspense fallback={<div className="page center muted">{t('Loading the graph…')}</div>}>
            <MemoryGraph
              nodes={slice!.nodes}
              links={slice!.links}
              register={MEMORY_REGISTER}
              colorOf={colorOf}
              linkTintOf={linkTintOf}
              selectedId={selected?.id ?? null}
              onSelect={(n) => setSelected(n)}
              onOpen={open}
              reducedMotion={reducedMotion}
            />
          </Suspense>
        </div>

        <aside className="memory-side">
          {selected ? (
            <div className="memory-inspector">
              <div className="memory-node-name">{selected.name}</div>
              <div className="muted small">{selected.kind} · {selected.tier}</div>
              {selected.path && <div className="muted small memory-node-path">{selected.path}</div>}
              {selected.mtime && <div className="muted small">{t('touched')} {formatRelativeTime(selected.mtime)}</div>}
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
          </div>
        </aside>
      </div>
    </div>
  );
}
