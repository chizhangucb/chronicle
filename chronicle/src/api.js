async function j(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  scan: () => j('/api/scan'),
  import: (payload) => j('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  projects: () => j('/api/projects'),
  project: (id) => j(`/api/projects/${id}`),
  sessionMessages: (id) => j(`/api/sessions/${encodeURIComponent(id)}/messages`),
  gitAt: (project, ts) => j(`/api/git/at?project=${project}&ts=${encodeURIComponent(ts)}`),
  gitTree: (project, commit) => j(`/api/git/tree?project=${project}&commit=${commit}`),
  gitFile: (project, commit, path) =>
    j(`/api/git/file?project=${project}&commit=${commit}&path=${encodeURIComponent(path)}`),
};
