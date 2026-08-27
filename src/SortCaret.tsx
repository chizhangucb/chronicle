import React, { type JSX } from 'react';

// The ONE sort indicator, used across every sortable table (CHI-324 review —
// Chi asked for a consistent sort marker app-wide): a small brass ▾ caret shown
// on the active-sort column's header, paired with the `.sort-on` brass tint on
// that column's header + cells. Pass `on` = "this column is the current sort".
export default function SortCaret({ on }: { on: boolean }): JSX.Element | null {
  return on ? <span className="sort-car" aria-hidden="true"> ▾</span> : null;
}
