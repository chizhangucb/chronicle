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
  sessionMessages: (id) => j(`/api/sessions/${encodeURIComponent(id)}/messages`),
  deleteSessionSource: (id) => j(`/api/sessions/${encodeURIComponent(id)}/source-file`, { method: 'DELETE' }),
  deleteSession: (id, withSource) => j(`/api/sessions/${encodeURIComponent(id)}${withSource ? '?source=1' : ''}`, { method: 'DELETE' }),
  sendFeedback: (message) => j('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }),
  gitAt: (project, ts) => j(`/api/git/at?project=${project}&ts=${encodeURIComponent(ts)}`),
  gitTree: (project, commit) => j(`/api/git/tree?project=${project}&commit=${commit}`),
  gitFile: (project, commit, path) =>
    j(`/api/git/file?project=${project}&commit=${commit}&path=${encodeURIComponent(path)}`),
};
