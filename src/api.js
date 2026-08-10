async function j(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  scan: (params) => j('/api/scan' + (params ? `?${new URLSearchParams(params)}` : '')),
  import: (payload) => j('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  projects: () => j('/api/projects'),
  renameProject: (id, name) => j(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  deleteProject: (id) => j(`/api/projects/${id}`, { method: 'DELETE' }),
  syncProject: (id) => j(`/api/projects/${id}/sync`, { method: 'POST' }),
  project: (id, days) => j(`/api/projects/${id}${days ? `?days=${days}` : ''}`),
  search: (params) => j('/api/search?' + new URLSearchParams(params)),
  sessionMessages: (id) => j(`/api/sessions/${encodeURIComponent(id)}/messages`),
  renameSession: (id, name) => j(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  syncSession: (id) => j(`/api/sessions/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  deleteSessionSource: (id) => j(`/api/sessions/${encodeURIComponent(id)}/source-file`, { method: 'DELETE' }),
  deleteSession: (id, withSource) => j(`/api/sessions/${encodeURIComponent(id)}${withSource ? '?source=1' : ''}`, { method: 'DELETE' }),
  settings: () => j('/api/settings'),
  patchSettings: (patch) => j('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }),
  resolveSession: (id) => j(`/api/sessions/${encodeURIComponent(id)}/resolve`),
  gitAt: (project, ts) => j(`/api/git/at?project=${project}&ts=${encodeURIComponent(ts)}`),
  gitTree: (project, commit) => j(`/api/git/tree?project=${project}&commit=${commit}`),
  gitFile: (project, commit, path) =>
    j(`/api/git/file?project=${project}&commit=${commit}&path=${encodeURIComponent(path)}`),
};
