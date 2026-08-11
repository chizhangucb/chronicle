// server/scope.ts
// Turns a Scope into a SQL WHERE fragment (ANDed onto the standard
// COALESCE(s.minor,0)=0 gate) + its bind params. `s` is the sessions alias
// every engine query uses. Missing id on project/session degrades to 'all'
// rather than emitting a broken `= NULL` clause.
export type Scope = { type: 'all' | 'project' | 'session'; id?: number | string };

export function scopeClause(scope: Scope): { sql: string; params: (string | number)[] } {
  if (scope.type === 'project' && scope.id != null) return { sql: 'AND s.project_id = ?', params: [scope.id] };
  if (scope.type === 'session' && scope.id != null) return { sql: 'AND s.id = ?', params: [scope.id] };
  return { sql: '', params: [] };
}
