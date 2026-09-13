// The two breadcrumb dropdowns (issue #381).
//
// Both are mounted by the project page, and the session picker by the session
// view as well, which is why they live here rather than inside either page:
// a shared widget parked in a page file makes the other page import that page.
// They take pure props and hold only their own open/query state; what a typed
// query keeps, and how a row is titled and dated, is pickable.ts next door.
import React, { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { projectsUrl } from '../api.ts';
import { projectColorMap } from '../colors.ts';
import { prefetch, useCachedFetch } from '../useCachedFetch.ts';
import { sessionDisplayName } from '../../shared/sessionName.ts';
import {
  ago, matchesProjectQuery, matchesSessionQuery, sessionPickerTitle,
  type PickableProject, type PickableSession,
} from './pickable.ts';

interface ProjectPickerProps {
  current: PickableProject | null | undefined;
  onPick: (id: number | string) => void;
  // Identity color for the current project (from projectColorMap over all ids),
  // rendered as a `.pdot` on the trigger so the breadcrumb matches Home + head.
  color?: string;
}

// Project dropdown: switch projects from the breadcrumb, mirroring the session
// picker. Lazily loads the project list on first open.
export function ProjectPicker({ current, onPick, color }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // Task 5: SWR-cached list, keyed on the same '/api/projects' URL the hover
  // prefetch below warms — so by the time this popover opens the data is
  // usually already resolved (no "Loading…" flash).
  const { data: projects } = useCachedFetch<PickableProject[]>(projectsUrl());
  const list = (projects || []).filter((p) => matchesProjectQuery(p, q));
  // Per-item identity dots, same fixed order as Home's rail/ledger.
  const itemColors = useMemo(() => projectColorMap((projects ?? []).map((p) => p.id)), [projects]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="crumb on" title={current?.name} onMouseEnter={() => prefetch(projectsUrl())}>
          {current
            ? <span className="pdot" style={{ '--project-color': color } as React.CSSProperties} />
            : '◫ '}
          {current?.name || 'Projects'} <span className="muted">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu-pop picker-pop" align="start" sideOffset={6}>
          <input autoFocus className="search picker-search" placeholder="Search projects or sessions"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {projects === null && <div className="muted small pad8">Loading…</div>}
          {list.map((p) => (
            <button key={p.id} className="menu-item picker-item"
              onClick={() => { setOpen(false); if (p.id !== current?.id) onPick?.(p.id); }}>
              <span className="picker-check">{p.id === current?.id ? '✓' : ''}</span>
              <span className="picker-body">
                <span className="picker-title" title={p.name}>
                  <span className="pdot" style={{ '--project-color': itemColors.get(Number(p.id)) } as React.CSSProperties} />{p.name}
                </span>
                <span className="muted small">
                  {p.session_count} sessions
                  {p.last_active && ` · ${ago(p.last_active)}`}
                </span>
              </span>
            </button>
          ))}
          {projects && !list.length && <div className="muted small pad8">No projects match.</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface SessionPickerProps {
  sessions: PickableSession[] | null | undefined;
  current: PickableSession | null | undefined;
  onPick: (id: string) => void;
  loading?: boolean;
  // URL that supplies this picker's `sessions` prop in the caller's context
  // (there's no dedicated session-list endpoint — sessions arrive embedded in
  // GET /api/projects/:id) — hover-prefetched into the shared SWR cache so
  // navigating there next (or back to it) renders instantly. Optional: not
  // every mounting context has one to offer (e.g. SessionView's own picker,
  // out of scope for Task 5).
  prefetchUrl?: string;
}

// Session dropdown: shows on both project and session pages.
export function SessionPicker({ sessions, current, onPick, loading, prefetchUrl }: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = (sessions || []).filter((s) => matchesSessionQuery(s, q));

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={`crumb ${current ? 'on' : ''}`} title={current ? sessionDisplayName(current, 'label') : undefined}
          onMouseEnter={() => prefetchUrl && prefetch(prefetchUrl)}>
          ▤ {current ? sessionPickerTitle(current) : 'Select session'} <span className="muted">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu-pop picker-pop" align="start" sideOffset={6}>
          <input autoFocus className="search picker-search" placeholder="Search Sessions"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {loading && <div className="muted small pad8">Loading…</div>}
          {list.map((s) => (
            <button key={s.id} className="menu-item picker-item" onClick={() => { setOpen(false); onPick(s.id); }}>
              <span className="picker-check">{current?.id === s.id ? '✓' : ''}</span>
              <span className="picker-body">
                <span className="picker-title" title={sessionDisplayName(s, 'label')}>{sessionPickerTitle(s)}</span>
                <span className="muted small">{s.message_count} messages · {s.started_at ? ago(s.started_at) : ''}</span>
              </span>
            </button>
          ))}
          {!loading && !list.length && <div className="muted small pad8">No sessions match.</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
