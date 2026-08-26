/**
 * Node colors for the memory graph, drawn from the same validated palette as
 * the charts so the product reads as one system. Ember never appears here: the
 * graph is a picture of what you know, not something that needs a decision.
 *
 * M6 note: kinds now follow the scope model (wiki page kinds, governance,
 * context, contacts, references, registry + the record kinds). Colors group
 * by family; the M7 canvas rebuild owns the full visual story.
 *
 * Kept in its own module so the legend can import it without dragging three.js
 * into the entry chunk alongside it.
 */
export const MEMORY_KIND_COLOR: Record<string, string> = {
  // Wiki family: the connected heart of the graph wears heather violet.
  entity: "#9C7BD4",
  concept: "#B08FE0",
  synthesis: "#8A66C6",
  wiki: "#9C7BD4",
  // Living support kinds.
  governance: "#5488CB",
  registry: "#5488CB",
  skill: "#B8892F",
  context: "#249781",
  reference: "#6BA05A",
  contact: "#C875A0",
  note: "#8a93a3",
  // Records (historical tier): dated evidence, cooler and quieter.
  decision: "#5488CB",
  session: "#249781",
  brainstorm: "#C875A0",
  report: "#6BA05A",
  archive: "#5D655F",
  source: "#5D655F",
  record: "#5D655F",
  // Pre-M6 projections used "file" for wiki pages; keep it rendering.
  file: "#9C7BD4",
};

export const MEMORY_FALLBACK_COLOR = "#5D655F";

/** Notes that link to nothing: present, but not competing with the structure. */
export const MEMORY_UNLINKED_COLOR = "#39413B";

export const MEMORY_KIND_LABEL: Record<string, string> = {
  entity: "entities",
  concept: "concepts",
  synthesis: "syntheses",
  wiki: "wiki pages",
  governance: "governance",
  registry: "registry",
  skill: "skills",
  context: "context",
  reference: "references",
  contact: "contacts",
  note: "notes",
  decision: "decisions",
  session: "sessions",
  brainstorm: "brainstorms",
  report: "reports",
  archive: "archives",
  source: "sources",
  record: "records",
  file: "files",
};
