// server/scope.ts — the query-context module.
//
// One place hands an engine everything its queries need to be scoped and
// ranged: the scope clause, the minor gate (written ONCE here, never spelled
// out at a call site) and the three range fragments, exposed by name because
// they have different semantics — a session is in range by OVERLAP of its
// activity span, a message by its TIMESTAMP, and billed tokens by their
// IN-RANGE SHARE (server/rangeUsage.ts's cutoff). Every analytics engine takes
// `(scope, range)` and reads its fragments from `queryContext`; none takes a
// bare day count.
//
// `s` is the sessions alias every engine query uses; `m` the messages alias.
// Missing id on project/session degrades to 'all' rather than emitting a broken
// `= NULL` clause.
export type Scope = { type: 'all' | 'project' | 'session'; id?: number | string };

// A SQL fragment plus its binds. `sql` is AND-prefixed (or empty) so fragments
// compose in any order; `whereOf` strips the leading AND.
export interface SqlFragment { sql: string; params: (string | number)[] }

const DAY = 86400000;

// The time filter on a surface: Today, 7d, 30d, 90d, All (`days: null`).
// `now` is the wall clock the cutoff derives from — production passes none
// (Date.now()); a test pins it so results are not coupled to the time of day.
export interface Range {
  days: number | null;
  now: number;
  cutoffIso: string | null;
}

export function rangeOf(days: number | null, now: number = Date.now()): Range {
  return { days, now, cutoffIso: days != null ? new Date(now - days * DAY).toISOString() : null };
}

export function scopeClause(scope: Scope): SqlFragment {
  if (scope.type === 'project' && scope.id != null) return { sql: 'AND s.project_id = ?', params: [scope.id] };
  if (scope.type === 'session' && scope.id != null) return { sql: 'AND s.id = ?', params: [scope.id] };
  return { sql: '', params: [] };
}

// ANDed onto engine queries. For a directly-opened session, do NOT hide it
// even if the noise gate marked it minor — session scope already restricts to
// the one session, so the minor exclusion (meant for 'all'/'project'
// aggregates) is wrong here and leaves the pane blank.
export function minorGate(scope: Scope): string {
  return scope.type === 'session' ? '' : 'AND COALESCE(s.minor,0)=0';
}

export interface QueryContext {
  scope: Scope;
  range: Range;
  /** The scope clause on its own. */
  scopeSql: SqlFragment;
  /** The minor gate, written once. */
  minor: string;
  /** Minor gate + scope clause: what every sessions-aliased query ANDs on. */
  where: SqlFragment;
  /** Session range: in range by OVERLAP of [started_at, ended_at]. */
  sessions(alias?: string): SqlFragment;
  /** Message range: in range by TIMESTAMP. */
  messages(alias?: string): SqlFragment;
  /** Token range: in range by IN-RANGE SHARE (server/rangeUsage.ts's cutoff). */
  tokens: { cutoffIso: string | null };
}

export function queryContext(scope: Scope, range: Range): QueryContext {
  const sc = scopeClause(scope);
  const minor = minorGate(scope);
  const where: SqlFragment = {
    sql: [minor, sc.sql].filter(Boolean).join(' '),
    params: [...sc.params],
  };
  const cutoff = range.cutoffIso;
  return {
    scope,
    range,
    scopeSql: sc,
    minor,
    where,
    // A session whose activity ran INTO the range counts, even if it started
    // before the cutoff — ranges always extend to now, so overlap reduces to
    // "did this session's last known activity happen on or after the cutoff".
    sessions(alias = 's'): SqlFragment {
      if (cutoff == null) return { sql: '', params: [] };
      return { sql: `AND COALESCE(${alias}.ended_at, ${alias}.started_at, '9') >= ?`, params: [cutoff] };
    },
    // A message counts only if its own timestamp falls in the range — not
    // every message of a session that merely overlaps it.
    messages(alias = 'm'): SqlFragment {
      if (cutoff == null) return { sql: '', params: [] };
      return { sql: `AND ${alias}.ts >= ?`, params: [cutoff] };
    },
    tokens: { cutoffIso: cutoff },
  };
}

// Composes fragments into one WHERE body: empty fragments drop out, the
// leading AND is stripped, params follow fragment order, and an all-empty
// composition is `1=1` rather than a syntax error. A plain string is taken as
// a bind-free fragment.
export function whereOf(...fragments: (SqlFragment | string)[]): SqlFragment {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  for (const f of fragments) {
    const frag: SqlFragment = typeof f === 'string' ? { sql: f, params: [] } : f;
    const sql = frag.sql.trim();
    if (!sql) continue;
    parts.push(sql.replace(/^AND\s+/i, ''));
    params.push(...frag.params);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}
