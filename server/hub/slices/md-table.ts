// Shared markdown-table parsing core (ported from Varde aggregator/sources),
// used by any hub slice that reads a hand-maintained table out of a governance/
// ops markdown file. Parse: find section -> split rows -> clean cells -> map.

/** Strips markdown formatting (backticks, bold) and trims whitespace. */
export function cleanCell(cell: string): string {
  return cell
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .trim();
}

/**
 * Extracts the named `## <heading>` section (up to the next `## ` heading or end
 * of file) and returns its markdown-table rows as arrays of cleaned cell
 * strings, header and separator rows stripped.
 */
export function parseMdTableSection(md: string, heading: string): string[][] {
  const sectionMatch = md.match(new RegExp(`## ${heading}[\\s\\S]*?(?=\\n## |$)`));
  if (!sectionMatch) return [];
  const section = sectionMatch[0];
  const lines = section.split('\n').filter((line) => line.trim().startsWith('|'));
  // Skip header row and the separator row (|---|---|); data starts at index 2.
  return lines.slice(2).map((line) => line.split('|').slice(1, -1).map(cleanCell));
}

/**
 * Same section/table extraction, but keeps the header row so callers can map
 * columns by name instead of position. Column order can then change in the
 * source markdown without breaking parsers. Returns empty arrays when the
 * section or table is absent.
 */
export function parseMdTableSectionWithHeader(
  md: string,
  heading: string,
): { header: string[]; rows: string[][] } {
  const sectionMatch = md.match(new RegExp(`## ${heading}[\\s\\S]*?(?=\\n## |$)`));
  if (!sectionMatch) return { header: [], rows: [] };
  const lines = sectionMatch[0].split('\n').filter((line) => line.trim().startsWith('|'));
  if (lines.length < 2) return { header: [], rows: [] };
  const header = lines[0].split('|').slice(1, -1).map(cleanCell);
  const rows = lines.slice(2).map((line) => line.split('|').slice(1, -1).map(cleanCell));
  return { header, rows };
}
