import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Expand a leading "~" (or "~/…", "~\\…") to the user's home dir. Satellite
 * codegraph entries carry a display-friendly, tilde-rooted source path (e.g.
 * "~/aios-dashboard"); Node's fs never expands "~", so any existsSync over the
 * raw string is a guaranteed false - which silently prunes the satellite card
 * from the running dashboard (CHI-123). Anything without a leading "~" is
 * returned unchanged.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The /__graphify_list auto-prune predicate, pure and testable. A registry
 * entry stays in the gallery only if its built graph.json is on disk AND its
 * source repo still exists. Cloned projects (path "git:…" or empty) are kept
 * regardless - their graph lives in the dashboard, not a local repo. The
 * source-existence check runs through expandTilde so a tilde-rooted satellite
 * path resolves to a real directory instead of a literal "~/…" miss.
 *
 * `exists` is injected (defaults to fs.existsSync) so the dev-server middleware
 * and the regression test share one code path.
 */
export function codegraphSurvivesPrune(
  entry: { id?: string; path?: string; graphPath?: string },
  fallbackGraphPath: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  const gp = entry.graphPath || fallbackGraphPath;
  if (!exists(gp)) return false; // graph artefact gone
  const src = String(entry.path || "");
  if (src.startsWith("git:") || src === "") return true; // cloned → keep
  return exists(expandTilde(src)); // local repo must still exist (~ expanded)
}

/** One entry in the hub's `graphs/index.json` registry. */
export interface HubGraphEntry {
  name: string;
  source_path: string;
  out_dir: string;
  corpus: { files: number };
  graph: { nodes: number; edges: number; communities: number };
  last_built: string;
}

/** A most-connected node, surfaced so a viewer can jump straight to it. */
export interface GodNode {
  name: string;
  degree: number;
}

/**
 * Shape the dashboard's codegraph page expects (src/routes/codegraph.tsx
 * `Project` type), plus `graphPath`, the absolute path to this entry's
 * built `graph.json`, which the shared-brain prompt and the codegraph page
 * both read directly.
 */
export interface DashGraphEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  lang: string;
  color: string;
  nodeCount: number;
  edgeCount: number;
  communities: number;
  extractedPct: number;
  godNodes: GodNode[];
  graphPath: string;
}

/** Small deterministic palette, cycled by index so colors are stable run to run. */
const PALETTE = ["#7be0c8", "#e0b97b", "#7ba5e0", "#c87be0", "#e07b9a", "#a3e07b"];

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/**
 * Reads a built graph.json (networkx node-link format: `nodes` + `links`)
 * and returns the top 8 nodes by degree, labelled the same way the
 * codegraph page computes its live god-node list (label falling back to
 * norm_label, then id).
 */
function godNodesFromGraph(graphPath: string): GodNode[] {
  if (!existsSync(graphPath)) return [];
  const raw = JSON.parse(readFileSync(graphPath, "utf8"));
  const degree = new Map<string, number>();
  for (const link of raw.links ?? []) {
    const source = typeof link.source === "object" ? link.source?.id : link.source;
    const target = typeof link.target === "object" ? link.target?.id : link.target;
    if (source) degree.set(source, (degree.get(source) ?? 0) + 1);
    if (target) degree.set(target, (degree.get(target) ?? 0) + 1);
  }
  const label: Record<string, string> = {};
  for (const node of raw.nodes ?? []) {
    label[node.id] = node.label || node.norm_label || node.id;
  }
  return [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, deg]) => ({ name: label[id] ?? id, degree: deg }));
}

/**
 * Reads the hub's `graphs/index.json` registry and maps each entry into
 * the dashboard's DashGraphEntry shape. Field translation is a rename
 * (hub `graph.{nodes,edges,communities}` -> dash `nodeCount/edgeCount/
 * communities`); godNodes come from a degree count over the entry's real
 * graph.json when it's on disk, else [].
 */
export async function collectCodegraphs(hubRoot: string): Promise<DashGraphEntry[]> {
  const indexPath = join(hubRoot, "graphs", "index.json");
  if (!existsSync(indexPath)) return [];
  const { graphs } = JSON.parse(readFileSync(indexPath, "utf8")) as { graphs: HubGraphEntry[] };

  return graphs.map((entry, index) => {
    const graphPath = resolve(hubRoot, entry.out_dir, "graph.json");
    return {
      id: entry.name,
      name: entry.name,
      description: `${entry.name} (${entry.source_path})`,
      path: entry.source_path,
      lang: "Code",
      color: colorFor(index),
      nodeCount: entry.graph.nodes,
      edgeCount: entry.graph.edges,
      communities: entry.graph.communities,
      extractedPct: 100,
      godNodes: godNodesFromGraph(graphPath),
      graphPath,
    };
  });
}

/**
 * Materializes each entry's graph.json into `destDir/<id>.json`, the flat
 * layout the dev server's `/__graphify_graph?id=` route and the codegraph
 * page's static-glob fallback both expect (vite.config.ts resolves
 * `src/data/graphs/<id>.json` directly, it does not follow `graphPath`).
 * Entries whose graph.json isn't built yet are skipped. Returns the ids
 * actually copied.
 */
export function materializeCodegraphs(entries: DashGraphEntry[], destDir: string): string[] {
  const copied: string[] = [];
  for (const entry of entries) {
    if (!existsSync(entry.graphPath)) continue;
    mkdirSync(destDir, { recursive: true });
    copyFileSync(entry.graphPath, join(destDir, `${entry.id}.json`));
    copied.push(entry.id);
  }
  return copied;
}
