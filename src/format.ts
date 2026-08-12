// Shared display formatters (PR1 design-system foundation). Single source for
// integer/money/count-noun formatting — later PRs and existing local
// duplicates should converge on these instead of hand-rolling `toFixed`/
// string concatenation. Client-pure, no deps.

export function fmtInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

export function fmtMoney(n: number, dp: 0 | 2 = 0): string {
  if (!Number.isFinite(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pluralize(n: number, one: string, many: string): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}
