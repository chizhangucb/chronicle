// Categorical palette (matches --c1..--c5 in styles.css) — fixed order,
// never cycled: brass · teal · blue · terracotta · violet.
export const CATEGORICAL_COLORS = ['#c08a1e', '#2f9d82', '#5585d6', '#cd5f3c', '#9a6cc9'] as const;

// Per-project identity color ("color follows the entity"): each project gets
// a stable hue from the categorical palette, assigned in fixed order by
// project id. The 6th+ project is omitted from the map — callers leave
// `--project-color` unset for it, and `.pill.proj`/`.pdot` in styles.css
// fall back to neutral ink rather than repeating a color.
export function projectColorMap(ids: (number | string)[]): Map<number | string, string> {
  const sorted = [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
  const map = new Map<number | string, string>();
  sorted.forEach((id, i) => {
    if (i < CATEGORICAL_COLORS.length) map.set(id, CATEGORICAL_COLORS[i]);
  });
  return map;
}
