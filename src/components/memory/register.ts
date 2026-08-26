import type { MemoryLink, MemoryNode } from "./types.ts";

/**
 * The Memory canvas register: every knob the M7 design gate explores, typed
 * as one config so the morning pick is a one-line flip of
 * MEMORY_REGISTER_NAME below. Nothing in the engine, interactions, lenses,
 * legend or page structure changes with the pick; only this file's constants.
 *
 * No three.js in here: the page and legend import this module without
 * dragging the heavy lazy chunk into the entry bundle.
 */

export type MemoryColorMode = "kind" | "cluster" | "heat";
export type MemoryEdgeStyle = "line" | "flow";
export type MemoryNodeStyle = "flat" | "glow" | "hybrid";
export type MemoryAtmosphere = "none" | "medium" | "deep";

export interface MemoryRegister {
  /** Base color story: kind palette, deterministic communities, or usage heat. */
  colorMode: MemoryColorMode;
  /** Hairline lines vs curved arcs with slow flow particles. */
  edgeStyle: MemoryEdgeStyle;
  /** Matte discs, additive glow sprites, or the Gate A hybrid: crisp lit
   * sphere cores with a small additive aura on hubs only (god-node stars and
   * their always-on labels stay in glow and hybrid). */
  nodeStyle: MemoryNodeStyle;
  /** Radial tints inside the canvas; deep adds a faint starfield. */
  atmosphere: MemoryAtmosphere;
  /** Slow camera drift while idle. Reduced motion disables it regardless. */
  ambientMotion: boolean;
  /** V3 nuance: links touching a record render dimmer than living-to-living. */
  tieredEdges: boolean;
}

export type MemoryRegisterName = "v1" | "v2" | "v3";

export const MEMORY_REGISTERS: Record<MemoryRegisterName, MemoryRegister> = {
  /** Neutral default until the pick: kind colors, hairlines, matte, calm. */
  v1: {
    colorMode: "kind",
    edgeStyle: "line",
    nodeStyle: "flat",
    atmosphere: "medium",
    ambientMotion: false,
    tieredEdges: false,
  },
  /** V2 Nebula, amended at Gate A: communities, flow arcs, deep space,
   * drift, and the hybrid node treatment (crisp cores, aura on hubs only). */
  v2: {
    colorMode: "cluster",
    edgeStyle: "flow",
    nodeStyle: "hybrid",
    atmosphere: "deep",
    ambientMotion: true,
    tieredEdges: false,
  },
  /** The heat-story direction: usage IS the color; record links recede. */
  v3: {
    colorMode: "heat",
    edgeStyle: "line",
    nodeStyle: "flat",
    atmosphere: "medium",
    ambientMotion: false,
    tieredEdges: true,
  },
};

/** THE PICK LINE. Chi picked V2 Nebula at the Round 4 gate (2026-08-20). */
export const MEMORY_REGISTER_NAME: MemoryRegisterName = "v2";

export const MEMORY_REGISTER: MemoryRegister = MEMORY_REGISTERS[MEMORY_REGISTER_NAME];

// ---------------------------------------------------------------------------
// Color helpers shared by the color modes and the lenses.

/** Normalize to #rrggbb and append a two-hex-digit alpha, replacing any old one. */
export function fadeColor(hex: string, alpha: string): string {
  const base = hex.length >= 7 ? hex.slice(0, 7) : hex;
  return `${base}${alpha}`;
}

function channel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) || 0;
}

/** Linear interpolation between two #rrggbb colors, t in 0..1. */
export function mixColor(from: string, to: string, t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const parts = [0, 1, 2].map((i) => {
    const v = Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * clamped);
    return v.toString(16).padStart(2, "0");
  });
  return `#${parts.join("")}`;
}

// ---------------------------------------------------------------------------
// Usage heat: the ramp both colorMode "heat" and the heat lens read.

/** Zero-touch base under the heat story: calm, present, honest. */
export const HEAT_BASE = "#4a544e";

const HEAT_COLD = "#3f7a6b";
const HEAT_MID = "#b8892f";
const HEAT_HOT = "#c875a0";

/**
 * Touch count to color, log-scaled against the window's hottest note so one
 * god note does not flatten everyone else to cold. Callers keep zero-touch
 * nodes on the base story; this is only for touches > 0.
 */
export function heatColor(touches: number, maxTouches: number): string {
  const t = Math.log1p(Math.max(0, touches)) / Math.log1p(Math.max(1, maxTouches));
  return t < 0.5 ? mixColor(HEAT_COLD, HEAT_MID, t * 2) : mixColor(HEAT_MID, HEAT_HOT, (t - 0.5) * 2);
}

// ---------------------------------------------------------------------------
// Deterministic community detection for colorMode "cluster".

/**
 * The cluster palette: the six identity hues then their text tints, so up to
 * twelve communities read distinctly on #111312. Fixed order by cluster size;
 * smaller communities fall back to the quiet neutral.
 */
export const CLUSTER_PALETTE = [
  "#9c7bd4",
  "#5488cb",
  "#249781",
  "#b8892f",
  "#c875a0",
  "#6ba05a",
  "#b79ee0",
  "#82aee3",
  "#47b89e",
  "#d2a855",
  "#db93b4",
  "#8cbb7a",
];

export const CLUSTER_FALLBACK = "#5d655f";

/** Clusters smaller than this share the fallback color instead of a hue. */
const CLUSTER_MIN_SIZE = 3;

const endId = (end: MemoryLink["source"]): string =>
  typeof end === "object" && end !== null
    ? String((end as { id?: string }).id ?? "")
    : String(end);

/** Share of highest-degree nodes frozen during propagation (min 6). Plain
 * label propagation collapses a hub-dominated hub graph into ONE community
 * (measured on real data: one 541-node blob); freezing the top hubs and
 * assigning them by neighbor majority afterwards yields real structure
 * (4% gave 20 communities with a 71/63/54/50/46 top on the same graph). */
const HUB_FREEZE_SHARE = 0.04;

/**
 * Hub-attenuated label propagation over the undirected link graph. Fully
 * deterministic: nodes sweep in sorted-id order, labels update synchronously
 * in place, ties break toward the smallest label, the loop caps at a fixed
 * iteration budget, and the frozen hub set is degree-then-id ordered. Same
 * graph in, same colors out, every time.
 */
export function clusterColors(nodes: MemoryNode[], links: MemoryLink[]): Map<string, string> {
  const order = nodes.map((n) => n.id).sort();
  const index = new Map(order.map((id, i) => [id, i]));
  const label = order.map((_, i) => i);
  const adj: number[][] = order.map(() => []);
  for (const link of links) {
    const s = index.get(endId(link.source));
    const t = index.get(endId(link.target));
    if (s == null || t == null || s === t) continue;
    adj[s].push(t);
    adj[t].push(s);
  }
  // The floor of 6 only applies once the graph is big enough that freezing
  // 6 nodes cannot swallow it whole; a toy graph freezes nothing and plain
  // propagation already separates its communities.
  const hubCount = Math.min(
    Math.floor(order.length / 10),
    Math.max(6, Math.round(order.length * HUB_FREEZE_SHARE)),
  );
  const frozen = new Set(
    order
      .map((_, i) => i)
      .sort((a, b) => adj[b].length - adj[a].length || a - b)
      .slice(0, hubCount),
  );
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (let i = 0; i < order.length; i++) {
      if (adj[i].length === 0 || frozen.has(i)) continue;
      const tally = new Map<number, number>();
      for (const j of adj[i]) {
        if (frozen.has(j)) continue;
        tally.set(label[j], (tally.get(label[j]) ?? 0) + 1);
      }
      let best = label[i];
      let bestCount = 0;
      for (const [l, c] of tally) {
        if (c > bestCount || (c === bestCount && l < best)) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label[i]) {
        label[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Hubs join the community most of their non-hub neighbors settled on.
  for (const h of frozen) {
    const tally = new Map<number, number>();
    for (const j of adj[h]) {
      if (frozen.has(j)) continue;
      tally.set(label[j], (tally.get(label[j]) ?? 0) + 1);
    }
    let best = label[h];
    let bestCount = 0;
    for (const [l, c] of tally) {
      if (c > bestCount || (c === bestCount && l < best)) {
        best = l;
        bestCount = c;
      }
    }
    label[h] = best;
  }
  const sizes = new Map<number, number>();
  for (const l of label) sizes.set(l, (sizes.get(l) ?? 0) + 1);
  const ranked = [...sizes.entries()]
    .filter(([, size]) => size >= CLUSTER_MIN_SIZE)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([l]) => l);
  const colorByLabel = new Map<number, string>();
  ranked.forEach((l, i) => {
    colorByLabel.set(l, CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]);
  });
  const out = new Map<string, string>();
  order.forEach((id, i) => {
    out.set(id, colorByLabel.get(label[i]) ?? CLUSTER_FALLBACK);
  });
  return out;
}
