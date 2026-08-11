// server/calibrate.ts
// The ONE calibration primitive shared by Explore (tool/skill × Tokens/Spend)
// and Content (kind composition, tool-results-by-tool). Chronicle bills tokens
// per assistant turn, not per tool-call/kind, so "tokens attributable to X" is
// estimated as X's share of message TEXT LENGTH, scaled to the real billed
// total. Rounded to whole tokens. Callers set the `calibrated: true` flag on
// any result built from this so the UI can badge it.
export function calibrateByBucket(
  buckets: { key: string; chars: number }[],
  billedTotal: number,
): { key: string; tokens: number }[] {
  const totalChars = buckets.reduce((n, b) => n + b.chars, 0);
  if (totalChars === 0) return buckets.map((b) => ({ key: b.key, tokens: 0 }));
  return buckets.map((b) => ({ key: b.key, tokens: Math.round((b.chars / totalChars) * billedTotal) }));
}
