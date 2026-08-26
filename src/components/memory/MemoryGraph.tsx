import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-3d";
import * as THREE from "three";
import type { MemoryLink, MemoryNode } from "./types.ts";
import { formatRelativeTime as ago } from "../../relativeTime.js";
import { fadeColor, type MemoryRegister } from "./register.ts";

/**
 * The three.js layer of the Memory canvas: rendering, hover link tracing,
 * click/double-click, ambient drift. Everything visual is driven by the
 * register config plus the colorOf/emphasisOf callbacks the canvas shell
 * passes in; this component decides HOW to draw, never WHAT color story to
 * tell. Loaded lazily; nothing outside imports three through it.
 */

/** dim = focus/lens background; boost = a lens is pointing at this node. */
export type NodeEmphasis = "dim" | "base" | "boost";

export interface MemoryGraphProps {
  nodes: MemoryNode[];
  links: MemoryLink[];
  register: MemoryRegister;
  /** The base color story (register mode + lens + focus + window dimming). */
  colorOf: (node: MemoryNode) => string;
  emphasisOf?: (node: MemoryNode) => NodeEmphasis;
  /** Persistent trace source: the inspected node keeps its links lit. */
  selectedId?: string | null;
  onSelect?: (node: MemoryNode | null) => void;
  /** Double-click; the shell wires it to open-file. */
  onOpen?: (node: MemoryNode) => void;
  /** True disables ALL motion: drift and flow particles. */
  reducedMotion?: boolean;
  /**
   * The LINKS slider, 0..1. Drives untraced-link opacity always; past the
   * midpoint it also buys real width (cylinder geometry), which is honest
   * about its cost: hairline GL lines are what keep 3.3k links cheap.
   */
  linkBoost?: number;
  /** Base color story for a link (cluster tint under Nebula); null = neutral. */
  linkTintOf?: (sourceId: string, targetId: string) => string | null;
}

const LINK_BASE = "#5d655f";
const LINK_RECORD = "#454b47";
const LINK_TRACE = "#d8ded8";
/** God-node stars: this many top hubs under the glow and hybrid styles. */
const STAR_HUBS = 6;
/** Beyond the stars, this many next hubs carry an always-on name (round 3:
 * "nodes look too similar, I cannot identify the key information"). */
const LABEL_HUBS = 14;
/** Hybrid style: the share of top-degree nodes that carry a small aura. */
const AURA_SHARE = 0.05;
const AURA_MIN_HUBS = 12;

export function MemoryGraph({
  nodes,
  links,
  register,
  colorOf,
  emphasisOf,
  selectedId = null,
  onSelect,
  onOpen,
  reducedMotion = false,
  linkBoost = 0.35,
  linkTintOf,
}: MemoryGraphProps) {
  const wrap = useRef<HTMLDivElement>(null);
  // The library's ref generics resolve against its own NodeObject wrapper, so
  // the ref is typed the way the component declares it rather than by our node
  // shape. Only zoomToFit and cameraPosition are used off it.
  const graphRef = useRef<ForceGraphMethods<NodeObject<object>, LinkObject<object, MemoryLink>>>(
    undefined,
  );
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const spriteById = useRef(new Map<string, THREE.Sprite>());

  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The graph library mutates the objects it is handed (it writes simulation
  // coordinates onto them), so it gets copies rather than the fetched payload.
  const graph = useMemo(() => {
    spriteById.current.clear();
    return {
      nodes: nodes.map((node) => ({ ...node })),
      links: links.map((link) => ({ ...link })),
    };
  }, [nodes, links]);

  // The camera frames the LARGEST connected component. Fitting every linked
  // node fails on real hubs: isolated linked pairs (a record and its one
  // file) drift far from the main mass and inflate the fit box until the
  // structure you came for is a speck.
  const mainComponent = useMemo(() => {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    for (const link of links) {
      const s = endId(link.source);
      const t = endId(link.target);
      if (!parent.has(s)) parent.set(s, s);
      if (!parent.has(t)) parent.set(t, t);
      parent.set(find(s), find(t));
    }
    const sizes = new Map<string, number>();
    for (const id of parent.keys()) {
      const root = find(id);
      sizes.set(root, (sizes.get(root) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestSize = 0;
    for (const [root, size] of sizes) {
      if (size > bestSize || (size === bestSize && (best == null || root < best))) {
        best = root;
        bestSize = size;
      }
    }
    const ids = new Set<string>();
    if (best != null) {
      for (const id of parent.keys()) if (find(id) === best) ids.add(id);
    }
    return ids;
  }, [links]);

  const degree = useMemo(() => {
    const tally = new Map<string, number>();
    for (const link of links) {
      const s = endId(link.source);
      const t = endId(link.target);
      tally.set(s, (tally.get(s) ?? 0) + 1);
      tally.set(t, (tally.get(t) ?? 0) + 1);
    }
    return tally;
  }, [links]);

  const recordIds = useMemo(
    () => new Set(nodes.filter((n) => n.tier === "historical").map((n) => n.id)),
    [nodes],
  );

  /** Top hubs by degree; these wear the star sprite under glow and hybrid. */
  const starIds = useMemo(() => {
    const ranked = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return new Set(ranked.slice(0, STAR_HUBS).map(([id]) => id));
  }, [degree]);

  /** The next tier of hubs after the stars: always-on name, no star flare. */
  const labelIds = useMemo(() => {
    const ranked = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return new Set(ranked.slice(STAR_HUBS, STAR_HUBS + LABEL_HUBS).map(([id]) => id));
  }, [degree]);

  /** Hybrid style: hubs (top share by degree) carry a small additive aura;
   * everyone else is a bare crisp sphere. */
  const auraIds = useMemo(() => {
    const ranked = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const n = Math.max(AURA_MIN_HUBS, Math.round(ranked.length * AURA_SHARE));
    return new Set(ranked.slice(0, n).map(([id]) => id));
  }, [degree]);

  // Hover (or the inspected node) traces its links: it and its neighbors keep
  // the color story, everything else steps far back.
  const traceId = hoverId ?? selectedId ?? null;
  const neighbors = useMemo(() => {
    const set = new Set<string>();
    if (!traceId) return set;
    for (const link of links) {
      const s = endId(link.source);
      const t = endId(link.target);
      if (s === traceId) set.add(t);
      if (t === traceId) set.add(s);
    }
    return set;
  }, [links, traceId]);

  const nodeColor = useCallback(
    (o: object): string => {
      const n = o as MemoryNode;
      const base = colorOf(n);
      if (!traceId || n.id === traceId || neighbors.has(n.id)) return base;
      return fadeColor(base, "26");
    },
    [colorOf, traceId, neighbors],
  );

  const nodeVal = useCallback(
    (o: object): number => {
      const n = o as MemoryNode;
      const emphasis = emphasisOf?.(n) ?? "base";
      if (emphasis === "dim") return 0.5;
      const deg = degree.get(n.id) ?? 0;
      // Round 3 ("nodes look too similar"): the spread widened; leaves start
      // smaller and hubs climb higher before the cap, so link degree reads
      // at a glance instead of everything rendering near one size.
      const drama = register.nodeStyle === "glow" ? 1.5 : register.nodeStyle === "hybrid" ? 1.3 : 0.9;
      const cap = register.nodeStyle === "glow" ? 26 : register.nodeStyle === "hybrid" ? 30 : 14;
      const base = register.nodeStyle === "hybrid" ? 0.6 : 1;
      const val = Math.min(base + Math.pow(deg, register.nodeStyle === "hybrid" ? 0.8 : 0.7) * drama, cap);
      return emphasis === "boost" ? Math.max(val * 1.6, 4) : val;
    },
    [degree, emphasisOf, register.nodeStyle],
  );

  const linkColor = useCallback(
    (l: object): string => {
      const link = l as MemoryLink;
      const s = endId(link.source);
      const t = endId(link.target);
      if (traceId && (s === traceId || t === traceId)) return LINK_TRACE;
      const tinted = linkTintOf?.(s, t);
      const base =
        tinted ??
        (register.tieredEdges && (recordIds.has(s) || recordIds.has(t)) ? LINK_RECORD : LINK_BASE);
      if (traceId) return fadeColor(base, "1f");
      // The slider's lower half is pure visibility: alpha from a whisper to
      // solid, still free GL lines.
      const alpha = Math.round(0x35 + Math.min(1, Math.max(0, linkBoost)) * 0xca)
        .toString(16)
        .padStart(2, "0");
      return fadeColor(base, alpha);
    },
    [traceId, recordIds, register.tieredEdges, linkTintOf, linkBoost],
  );

  const linkWidth = useCallback(
    (l: object): number => {
      const link = l as MemoryLink;
      if (traceId && (endId(link.source) === traceId || endId(link.target) === traceId)) return 1.4;
      // Below the midpoint, 0 keeps untraced links as cheap GL lines. The
      // slider's upper half buys real width (cylinder geometry per link),
      // the one setting that costs frames on a 3k-link graph.
      const boost = Math.min(1, Math.max(0, linkBoost));
      return boost <= 0.5 ? 0 : (boost - 0.5) * 2 * 1.5;
    },
    [traceId, linkBoost],
  );

  // Glow style: shared additive textures, one sprite per node. Colors are
  // applied at creation (through a ref, because the library builds sprites
  // after this commit) and re-applied imperatively on story changes, so hover
  // tracing never recreates 1.2k objects.
  const nodeColorRef = useRef(nodeColor);
  nodeColorRef.current = nodeColor;
  const tintSprite = (sprite: THREE.Sprite, color: string): void => {
    sprite.material.color.set(color.slice(0, 7));
    const alpha = color.length > 7 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1;
    // Auras carry their own base opacity; the color story multiplies it.
    const base = (sprite.userData.baseOpacity as number | undefined) ?? 1;
    sprite.material.opacity = alpha * base;
  };
  const glowObject = useCallback(
    (o: object): THREE.Object3D => {
      const n = o as MemoryNode;
      const material = new THREE.SpriteMaterial({
        map: starIds.has(n.id) ? starTexture() : glowTexture(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });
      const sprite = new THREE.Sprite(material);
      const scale = Math.cbrt(nodeVal(n)) * (starIds.has(n.id) ? 16 : 11);
      sprite.scale.set(scale, scale, 1);
      tintSprite(sprite, nodeColorRef.current(n));
      spriteById.current.set(n.id, sprite);
      if (!starIds.has(n.id)) return sprite;
      // God nodes carry their names all the time: the emphasis rule is pure
      // link degree, and an unnamed emphasis reads as decoration, not data.
      const group = new THREE.Group();
      group.add(sprite);
      group.add(labelSprite(n.name, scale * 0.34, Math.max(8, scale * 0.4)));
      return group;
    },
    [starIds, nodeVal],
  );

  /** Flat style keeps the library's spheres; star hubs still get their name.
   * The accessor type demands an object for every node, so non-hubs get an
   * empty group (the extend flag keeps their default sphere either way). */
  const flatLabelExtend = useCallback(
    (o: object): THREE.Object3D => {
      const n = o as MemoryNode;
      if (!starIds.has(n.id)) return new THREE.Group();
      return labelSprite(n.name, Math.cbrt(nodeVal(n)) * 4.2, 8);
    },
    [starIds, nodeVal],
  );

  /**
   * Hybrid (Gate A, the V2 amendment): the library's crisp lit sphere is the
   * core for every node; hubs additionally carry a SMALL additive aura, and
   * the god nodes keep their star flare + always-on name. Extend objects, so
   * the sphere is never replaced.
   */
  const hybridExtend = useCallback(
    (o: object): THREE.Object3D => {
      const n = o as MemoryNode;
      const isStar = starIds.has(n.id);
      // Second label tier: named hub, no aura of its own required.
      if (!isStar && !auraIds.has(n.id)) {
        if (!labelIds.has(n.id)) return new THREE.Group();
        const radius = Math.cbrt(nodeVal(n)) * 3;
        return labelSprite(n.name, radius * 0.9, Math.max(7, radius * 1.05));
      }
      const group = new THREE.Group();
      const material = new THREE.SpriteMaterial({
        map: isStar ? starTexture() : glowTexture(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: isStar ? 0.9 : 0.5,
      });
      const sprite = new THREE.Sprite(material);
      sprite.userData.baseOpacity = isStar ? 0.9 : 0.5;
      // Aura stays small: ~2.2x the sphere radius; stars flare a bit wider.
      const radius = Math.cbrt(nodeVal(n)) * 3;
      const scale = radius * (isStar ? 4.6 : 2.2);
      sprite.scale.set(scale, scale, 1);
      tintSprite(sprite, nodeColorRef.current(n));
      spriteById.current.set(n.id, sprite);
      group.add(sprite);
      if (isStar) group.add(labelSprite(n.name, radius * 1.1, Math.max(8, radius * 1.3)));
      else if (labelIds.has(n.id))
        group.add(labelSprite(n.name, radius * 0.9, Math.max(7, radius * 1.05)));
      return group;
    },
    [starIds, auraIds, labelIds, nodeVal],
  );

  useEffect(() => {
    if (register.nodeStyle === "flat") return;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const [id, sprite] of spriteById.current) {
      const node = byId.get(id);
      if (node) tintSprite(sprite, nodeColor(node));
    }
  }, [register.nodeStyle, graph, nodeColor]);

  // Retina fix (Gate A: "blurry nodes"): the graph library leaves the WebGL
  // renderer at pixel ratio 1, so retina displays draw at quarter resolution
  // and every sphere smears. Capped at 2: past that the fill cost buys no
  // visible sharpness.
  useEffect(() => {
    if (size.width === 0) return;
    const g = graphRef.current;
    if (!g) return;
    const renderer = g.renderer() as THREE.WebGLRenderer | undefined;
    renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }, [size.width]);

  // Navigation feel (round 3: "clunky zoom, snaps back by itself"). The
  // canvas uses ORBIT controls (drag orbits, wheel zooms toward the target,
  // no trackball roll) with inertial damping and hard distance clamps, so
  // zooming can neither punch through the cluster nor bounce back out.
  useEffect(() => {
    if (size.width === 0) return;
    const g = graphRef.current;
    if (!g) return;
    const controls = g.controls() as unknown as {
      enableDamping?: boolean;
      dampingFactor?: number;
      zoomSpeed?: number;
      minDistance?: number;
      maxDistance?: number;
    };
    if (!controls) return;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.zoomSpeed = 1.1;
    controls.minDistance = 12;
    controls.maxDistance = 6000;
  }, [size.width]);

  /** True from the first pointer/wheel interaction until the graph data
   * changes: after it, NOTHING moves the camera programmatically (round 3:
   * the settle-fit re-firing on engine reheat yanked the camera mid-zoom). */
  const interacted = useRef(false);
  /** The one allowed settle-fit per graph. */
  const fitDone = useRef(false);
  /** Engine tick counter for the provisional early fit. */
  const ticks = useRef(0);
  const provisionalDone = useRef(false);
  useEffect(() => {
    interacted.current = false;
    fitDone.current = false;
    ticks.current = 0;
    provisionalDone.current = false;
  }, [graph]);
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const latch = () => {
      interacted.current = true;
    };
    element.addEventListener("pointerdown", latch);
    element.addEventListener("wheel", latch, { passive: true });
    return () => {
      element.removeEventListener("pointerdown", latch);
      element.removeEventListener("wheel", latch);
    };
  }, []);

  /** The landing center from the percentile fit; drift orbits IT, never the
   * world origin (orbiting origin was what pushed the cluster off-center). */
  const fitCenter = useRef<{ x: number; y: number; z: number } | null>(null);
  /** Drift holds off until the fit tween lands: a per-frame cameraPosition
   * call would cancel the transition and strand the camera at the default
   * distant view. */
  const driftHoldUntil = useRef(0);

  // Ambient drift: a slow orbit around the framed center while nobody is
  // interacting. First real interaction hands the camera back for good;
  // reduced motion never starts.
  useEffect(() => {
    hoverRef.current = hoverId;
  }, [hoverId]);
  useEffect(() => {
    if (!register.ambientMotion || reducedMotion) return;
    const element = wrap.current;
    let stopped = false;
    let raf = 0;
    const halt = () => {
      stopped = true;
    };
    element?.addEventListener("pointerdown", halt);
    element?.addEventListener("wheel", halt, { passive: true });
    const tick = () => {
      if (stopped) return;
      const g = graphRef.current;
      const c = fitCenter.current;
      if (
        g &&
        c &&
        !interacted.current &&
        hoverRef.current == null &&
        performance.now() >= driftHoldUntil.current
      ) {
        const p = g.camera().position;
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const r = Math.hypot(dx, dz);
        if (r > 1) {
          const a = Math.atan2(dx, dz) + 0.00045;
          g.cameraPosition({ x: c.x + r * Math.sin(a), y: p.y, z: c.z + r * Math.cos(a) }, c);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      element?.removeEventListener("pointerdown", halt);
      element?.removeEventListener("wheel", halt);
    };
  }, [register.ambientMotion, reducedMotion]);

  const hoverCard = (node: MemoryNode): string => {
    const deg = degree.get(node.id) ?? 0;
    const meta = [
      node.kind,
      `${deg} link${deg === 1 ? "" : "s"}`,
      node.mtime ? `updated ${ago(node.mtime)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `<div style="background:#171a18;border:1px solid #2c332e;border-radius:8px;padding:8px 11px;font-size:14px;max-width:300px;">
      <div style="color:#f0f3f0;">${escapeHtml(node.name)}</div>
      <div style="margin-top:2px;color:#a9b2aa;font-size:13px;">${escapeHtml(meta)}</div>
      <div style="margin-top:4px;color:#7a847c;font-size:13px;">click to inspect · double-click to open</div>
    </div>`;
  };

  const lastClick = useRef({ id: "", at: 0 });

  /**
   * Frame the main structure: dust and stray components stay drawn but never
   * drive the camera. A plain bounding-box fit reads too distant on real
   * graphs (long record tendrils inflate the box), so the camera frames the
   * radius that holds ~86% of the main component, landing close (round 3:
   * the default view read far and small). Runs at most twice per graph: a
   * provisional pass while the layout is still settling (so the first seconds
   * are framed, not a distant speck) and the final pass at engine stop; a
   * user interaction cancels both forever.
   */
  const percentileFit = useCallback(
    (tweenMs: number) => {
      const g = graphRef.current;
      if (!g || interacted.current) return;
      const pts = (graph.nodes as Array<MemoryNode & { x?: number; y?: number; z?: number }>)
        .filter((n) => mainComponent.has(n.id) && Number.isFinite(n.x));
      if (pts.length < 3) {
        driftHoldUntil.current = performance.now() + 1000;
        g.zoomToFit(tweenMs, 40, (node: object) => mainComponent.has((node as MemoryNode).id));
        return;
      }
      const c = { x: 0, y: 0, z: 0 };
      for (const p of pts) {
        c.x += p.x!;
        c.y += p.y!;
        c.z += p.z!;
      }
      c.x /= pts.length;
      c.y /= pts.length;
      c.z /= pts.length;
      const dists = pts
        .map((p) => Math.hypot(p.x! - c.x, p.y! - c.y, p.z! - c.z))
        .sort((a, b) => a - b);
      const r = dists[Math.floor(dists.length * 0.86)] || 100;
      const fov = ((g.camera() as THREE.PerspectiveCamera).fov * Math.PI) / 180;
      const dist = (r / Math.tan(fov / 2)) * 1.05;
      fitCenter.current = c;
      driftHoldUntil.current = performance.now() + tweenMs + 300;
      g.cameraPosition({ x: c.x, y: c.y, z: c.z + dist }, c, tweenMs);
    },
    [graph, mainComponent],
  );

  return (
    <div ref={wrap} className="relative h-full w-full overflow-hidden">
      {size.width > 0 ? (
        <ForceGraph3D
          ref={graphRef}
          controlType="orbit"
          onEngineTick={() => {
            ticks.current += 1;
            if (!provisionalDone.current && ticks.current === 45) {
              provisionalDone.current = true;
              percentileFit(500);
            }
          }}
          onEngineStop={() => {
            if (fitDone.current) return;
            fitDone.current = true;
            percentileFit(900);
          }}
          width={size.width}
          height={size.height}
          graphData={graph}
          // Transparent: the shell's atmosphere layer shows through.
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          nodeLabel={(node: object) => hoverCard(node as MemoryNode)}
          nodeColor={nodeColor}
          // Hybrid cores are crisp: full opacity, higher sphere resolution.
          nodeOpacity={register.nodeStyle === "hybrid" ? 1 : 0.92}
          nodeResolution={register.nodeStyle === "hybrid" ? 16 : 8}
          nodeRelSize={3}
          nodeVal={nodeVal}
          nodeThreeObject={
            register.nodeStyle === "glow"
              ? glowObject
              : register.nodeStyle === "hybrid"
                ? hybridExtend
                : flatLabelExtend
          }
          nodeThreeObjectExtend={register.nodeStyle !== "glow"}
          onNodeHover={(node: object | null) => setHoverId(node ? (node as MemoryNode).id : null)}
          onNodeClick={(node: object) => {
            const n = node as MemoryNode;
            const now = Date.now();
            if (lastClick.current.id === n.id && now - lastClick.current.at < 400) {
              onOpen?.(n);
            } else {
              onSelect?.(n);
            }
            lastClick.current = { id: n.id, at: now };
          }}
          onBackgroundClick={() => onSelect?.(null)}
          linkColor={linkColor}
          linkOpacity={0.55}
          linkWidth={linkWidth}
          linkCurvature={register.edgeStyle === "flow" ? 0.22 : 0}
          linkDirectionalParticles={register.edgeStyle === "flow" && !reducedMotion ? 1 : 0}
          linkDirectionalParticleSpeed={0.0035}
          linkDirectionalParticleWidth={1.1 + Math.min(1, Math.max(0, linkBoost)) * 1.2}
          enableNodeDrag={false}
          // Bigger graphs get more settle time or they freeze as a clump; the
          // budget stays bounded so the layout always comes to rest.
          cooldownTicks={nodes.length > 600 ? 400 : 120}
        />
      ) : null}
    </div>
  );
}

const endId = (end: MemoryLink["source"]): string =>
  typeof end === "object" && end !== null
    ? String((end as { id?: string }).id ?? "")
    : String(end);

// ---------------------------------------------------------------------------
// Shared canvas textures for the glow style. Built once, tinted per sprite
// via material color, so a thousand nodes share two textures.

let glowTex: THREE.Texture | null = null;
let starTex: THREE.Texture | null = null;

function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.75)");
  g.addColorStop(0.6, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(canvas);
  return glowTex;
}

/** Four-point star for the god nodes: a glow core plus two cross flares. */
function starTexture(): THREE.Texture {
  if (starTex) return starTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const core = ctx.createRadialGradient(64, 64, 0, 64, 64, 30);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(0.5, "rgba(255,255,255,0.5)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, 128, 128);
  ctx.globalCompositeOperation = "lighter";
  for (const horizontal of [true, false]) {
    const flare = horizontal
      ? ctx.createLinearGradient(0, 64, 128, 64)
      : ctx.createLinearGradient(64, 0, 64, 128);
    flare.addColorStop(0, "rgba(255,255,255,0)");
    flare.addColorStop(0.5, "rgba(255,255,255,0.9)");
    flare.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = flare;
    if (horizontal) ctx.fillRect(0, 61, 128, 6);
    else ctx.fillRect(61, 0, 6, 128);
  }
  starTex = new THREE.CanvasTexture(canvas);
  return starTex;
}

// Hub name labels: one canvas texture per name, cached; only the top hubs
// ever ask, so the cache stays a handful of small textures.
const labelTexCache = new Map<string, { tex: THREE.Texture; aspect: number }>();

function labelTexture(name: string): { tex: THREE.Texture; aspect: number } {
  const cached = labelTexCache.get(name);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "500 26px 'Hanken Grotesk', ui-sans-serif, sans-serif";
  ctx.font = font;
  // Labels carry the note's short name; parenthetical suffixes like
  // "(archived evidence)" live in the hover card and inspect panel instead.
  const short = name.replace(/\s*\([^)]*\)\s*$/, "");
  const text = short.length > 28 ? `${short.slice(0, 27)}…` : short;
  const w = Math.ceil(ctx.measureText(text).width) + 18;
  const h = 40;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.textBaseline = "middle";
  // A soft dark plate keeps the name readable over glow and starfield.
  ctx.fillStyle = "rgba(17,19,18,0.55)";
  ctx.beginPath();
  ctx.roundRect(0, 4, w, h - 8, 8);
  ctx.fill();
  ctx.fillStyle = "#d8ded8";
  ctx.fillText(text, 9, h / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  const entry = { tex, aspect: w / h };
  labelTexCache.set(name, entry);
  return entry;
}

function labelSprite(name: string, offsetY: number, height: number): THREE.Sprite {
  const { tex, aspect } = labelTexture(name);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }),
  );
  sprite.scale.set(height * aspect, height, 1);
  sprite.position.set(0, -(offsetY + height * 0.7), 0);
  return sprite;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
