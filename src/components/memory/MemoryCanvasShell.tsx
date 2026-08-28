import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryNode, MemoryLink } from './types.ts';
import type { NodeEmphasis } from './MemoryGraph.tsx';
import { MEMORY_REGISTER, fadeColor, mixColor } from './register.ts';
import { MEMORY_KIND_COLOR, MEMORY_KIND_LABEL, MEMORY_FALLBACK_COLOR, MEMORY_UNLINKED_COLOR } from './kinds.ts';
import { windowCutoff, rangeWord } from './lanes.ts';
import type { RangeKey } from '../../RangeBar.js';
import { fmtInt } from '../../format.js';
import { t } from '../../i18n.js';
import InfoTip from '../../InfoTip.js';

// The canvas stage + its chrome (CHI-385 parity, ported from Varde's
// MemoryCanvas): usage-heat and orphan lenses, a kind legend that isolates one
// kind, the LINKS density slider, FULL/LITE draw, and fullscreen. It decides the
// COLOR STORY (colorOf/emphasisOf) and hands it to MemoryGraph, which owns only
// the three.js rendering. The three.js chunk stays lazy.
const MemoryGraph = lazy(() => import('./MemoryGraph.tsx').then((m) => ({ default: m.MemoryGraph })));

type Lens = 'none' | 'heat' | 'orphans';

/** Auto-LITE only past this size, and only when the cap would actually cut the
 * draw (a WQHD canvas runs a few thousand nodes at frame rate on FULL). */
const AUTO_LITE_NODES = 3000;

const endId = (end: MemoryLink['source']): string =>
  typeof end === 'object' && end !== null ? String((end as { id?: string }).id ?? '') : String(end);

export interface MemoryCanvasShellProps {
  nodes: MemoryNode[];
  links: MemoryLink[];
  /** Community colors over the FULL graph (the default color story). */
  clusterMap: Map<string, string>;
  /** Windowed touches per node id (the selected window's usage). */
  touches: Map<string, number>;
  range: RangeKey;
  capSuggested?: number;
  reducedMotion?: boolean;
  selectedId?: string | null;
  onSelect?: (node: MemoryNode | null) => void;
  onOpen?: (node: MemoryNode) => void;
}

export function MemoryCanvasShell({
  nodes, links, clusterMap, touches, range, capSuggested,
  reducedMotion = false, selectedId = null, onSelect, onOpen,
}: MemoryCanvasShellProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [lens, setLens] = useState<Lens>('none');
  const [focusKind, setFocusKind] = useState<string | null>(null);
  const [linkBoost, setLinkBoost] = useState(0.35);
  const [fullscreen, setFullscreen] = useState(false);

  const cap = capSuggested && capSuggested > 0 ? capSuggested : 250;
  const [mode, setMode] = useState<'full' | 'lite'>(() =>
    nodes.length > AUTO_LITE_NODES && cap < nodes.length ? 'lite' : 'full');

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of links) {
      const s = endId(l.source); const tgt = endId(l.target);
      d.set(s, (d.get(s) ?? 0) + 1);
      d.set(tgt, (d.get(tgt) ?? 0) + 1);
    }
    return d;
  }, [links]);

  // Orphans (the lens target): living notes with zero links AND zero touches in
  // the window; records are history, never flagged.
  const orphanIds = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) {
      if (n.tier !== 'historical' && (degree.get(n.id) ?? 0) === 0 && (touches.get(n.id) ?? 0) === 0) s.add(n.id);
    }
    return s;
  }, [nodes, degree, touches]);

  const maxTouches = useMemo(() => {
    let m = 0;
    for (const v of touches.values()) if (v > m) m = v;
    return m;
  }, [touches]);

  // LITE caps the draw to the most-connected nodes; nothing is dropped from the
  // reads, only fewer are painted.
  const drawnNodes = useMemo(() => {
    if (mode === 'full') return nodes;
    const ranked = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
    return ranked.slice(0, cap);
  }, [mode, nodes, degree, cap]);
  const drawnLinks = useMemo(() => {
    if (mode === 'full') return links;
    const ids = new Set(drawnNodes.map((n) => n.id));
    return links.filter((l) => ids.has(endId(l.source)) && ids.has(endId(l.target)));
  }, [mode, links, drawnNodes]);

  const dimBefore = range === 'all' ? 0 : windowCutoff(range);

  const colorOf = useCallback((node: MemoryNode): string => {
    const focused = focusKind != null && node.kind === focusKind;
    if (focusKind != null && !focused) return MEMORY_UNLINKED_COLOR;
    const kindColor = MEMORY_KIND_COLOR[node.kind] ?? MEMORY_FALLBACK_COLOR;
    const story = (): string =>
      clusterMap.get(node.id) ?? ((degree.get(node.id) ?? 0) > 0 ? kindColor : MEMORY_UNLINKED_COLOR);
    if (lens === 'orphans') {
      return orphanIds.has(node.id) ? kindColor : fadeColor(story(), '3d');
    }
    if (lens === 'heat') {
      const tv = touches.get(node.id) ?? 0;
      if (tv > 0) {
        const k = Math.log1p(tv) / Math.log1p(Math.max(1, maxTouches));
        return mixColor(story(), '#ffffff', 0.12 + 0.55 * k);
      }
      return fadeColor('#3c423e', '26');
    }
    let color = story();
    if (!focused && dimBefore && node.mtime && node.tier !== 'historical') {
      const at = new Date(node.mtime).getTime();
      if (!Number.isNaN(at) && at < dimBefore) color = fadeColor(color, '55');
    }
    return color;
  }, [focusKind, clusterMap, degree, lens, orphanIds, touches, maxTouches, dimBefore]);

  const emphasisOf = useCallback((node: MemoryNode): NodeEmphasis => {
    if (focusKind != null && node.kind !== focusKind) return 'dim';
    if (lens === 'orphans') return orphanIds.has(node.id) ? 'boost' : 'dim';
    if (lens === 'heat') {
      const tv = touches.get(node.id) ?? 0;
      if (tv === 0) return 'dim';
      const k = Math.log1p(tv) / Math.log1p(Math.max(1, maxTouches));
      return k >= 0.45 ? 'boost' : 'base';
    }
    return 'base';
  }, [focusKind, lens, orphanIds, touches, maxTouches]);

  const linkTintOf = useCallback((sourceId: string): string | null => clusterMap.get(sourceId) ?? null, [clusterMap]);

  const legendRows = useMemo(() => {
    const byTier: Record<'living' | 'historical', Map<string, number>> = { living: new Map(), historical: new Map() };
    for (const n of nodes) {
      const tier = n.tier === 'historical' ? 'historical' : 'living';
      byTier[tier].set(n.kind, (byTier[tier].get(n.kind) ?? 0) + 1);
    }
    const row = (tier: 'living' | 'historical') =>
      [...byTier[tier].entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [
      { key: 'living', label: t('Living'), chips: row('living') },
      { key: 'records', label: t('Records'), chips: row('historical') },
    ].filter((r) => r.chips.length > 0);
  }, [nodes]);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => {});
  };

  const caption = mode === 'full'
    ? `${t('all')} ${fmtInt(nodes.length)} ${t('notes')} · ${fmtInt(links.length)} ${t('links')}`
    : `${fmtInt(drawnNodes.length)} ${t('of')} ${fmtInt(nodes.length)} · LITE`;

  return (
    <>
      <div ref={wrapRef} className="memory-canvas-wrap" data-canvas-lens={lens} data-canvas-mode={mode}>
        <Suspense fallback={<div className="page center muted">{t('Loading the graph…')}</div>}>
          <MemoryGraph
            nodes={drawnNodes}
            links={drawnLinks}
            register={MEMORY_REGISTER}
            colorOf={colorOf}
            emphasisOf={emphasisOf}
            linkTintOf={linkTintOf}
            linkBoost={linkBoost}
            selectedId={selectedId}
            onSelect={(n) => onSelect?.(n)}
            onOpen={(n) => onOpen?.(n)}
            reducedMotion={reducedMotion}
          />
        </Suspense>

        <div className="mem-canvas-cap" data-canvas-caption>
          {caption}
          {lens === 'heat' ? ` · ${t('bright = touched in')} ${rangeWord(range)}` : ''}
        </div>

        <div className="mem-canvas-ctl" role="group" aria-label={t('Canvas controls')}>
          <button type="button" className={`mem-ghost-btn${lens === 'heat' ? ' on' : ''}`} aria-pressed={lens === 'heat'}
            data-lens="heat" onClick={() => setLens((c) => (c === 'heat' ? 'none' : 'heat'))}>{t('usage heat')}</button>
          <button type="button" className={`mem-ghost-btn${lens === 'orphans' ? ' on' : ''}`} aria-pressed={lens === 'orphans'}
            data-lens="orphans" onClick={() => setLens((c) => (c === 'orphans' ? 'none' : 'orphans'))}>{t('orphans')}</button>
          <InfoTip def="memory.lenses" />
          <span className="mem-ghost-sep" aria-hidden="true" />
          <span className="mem-ghost-group" role="group" aria-label={t('Draw mode')}>
            <button type="button" className={`mem-ghost-btn${mode === 'full' ? ' on' : ''}`} aria-pressed={mode === 'full'} onClick={() => setMode('full')}>FULL</button>
            <button type="button" className={`mem-ghost-btn${mode === 'lite' ? ' on' : ''}`} aria-pressed={mode === 'lite'} onClick={() => setMode('lite')}>LITE</button>
          </span>
          <InfoTip def="memory.full-lite" />
          {document.fullscreenEnabled ? (
            <>
              <span className="mem-ghost-sep" aria-hidden="true" />
              <button type="button" className="mem-ghost-btn" data-canvas-fullscreen
                aria-label={fullscreen ? t('Exit fullscreen') : t('Enter fullscreen')}
                onClick={toggleFullscreen}>{fullscreen ? '⤡' : '⤢'}</button>
            </>
          ) : null}
        </div>

        <div className="mem-links">
          <label htmlFor="mem-links-range">{t('links')}</label>
          <input id="mem-links-range" type="range" min={0} max={100} value={Math.round(linkBoost * 100)}
            title={t('Link visibility. The upper half adds real line width.')}
            onChange={(e) => setLinkBoost(Number(e.target.value) / 100)} />
        </div>
      </div>

      <div className="mem-legend" data-canvas-legend>
        {legendRows.map((r) => (
          <div className="mem-legend-row" key={r.key}>
            <span className="mem-legend-tier">{r.label}</span>
            {r.chips.map(([kind, n]) => {
              const active = focusKind === kind;
              const dimmed = focusKind != null && !active;
              return (
                <button key={kind} type="button"
                  className={`mem-legend-chip${active ? ' on' : ''}${dimmed ? ' off' : ''}`}
                  aria-pressed={active}
                  onClick={() => setFocusKind((c) => (c === kind ? null : kind))}>
                  <span className="sw" style={{ background: MEMORY_KIND_COLOR[kind] ?? MEMORY_FALLBACK_COLOR }} />
                  <span className="ct">{fmtInt(n)}</span>
                  {MEMORY_KIND_LABEL[kind] ?? kind}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
