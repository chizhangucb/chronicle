import React, { useMemo, useRef, useState } from 'react';
import type { Kind } from '@shared/types.ts';

// A timeline dot/tick — the minimal fields the ruler reads off a normalized
// event. `seq` is always present by the time messages reach this component
// (assigned at insert/live-SSE time).
export interface TimelineMessage {
  seq: number;
  kind: Kind;
  ts: string | null;
}

// A git commit tick — mirrors server/git.ts `Commit`, trimmed to what the
// timeline renders (hash/date/subject).
export interface TimelineCommit {
  hash: string;
  date: string;
  subject: string;
}

export interface TimelineProps {
  messages: TimelineMessage[];
  commits: TimelineCommit[];
  currentTs?: string | null;
  currentCommit?: TimelineCommit | null;
  onSeek: (ts: number) => void;
}

interface Range {
  min: number;
  max: number;
}

interface Hover {
  x: number;
  ts: number;
}

// TimberLine (FR-TT-5): blue dots = user messages, green squares = git commits,
// gray ticks = AI/tool events. Drag/click to seek, hover previews timestamp,
// arrow keys fine-tune (1%), Home/End jump when focused.
export default function Timeline({ messages, commits, currentTs, currentCommit, onSeek }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [dragging, setDragging] = useState(false);

  const range: Range | null = useMemo(() => {
    const times = messages.map((m) => m.ts).filter((v): v is string => Boolean(v)).map((ts) => new Date(ts).getTime());
    for (const c of commits) times.push(new Date(c.date).getTime());
    if (!times.length) return null;
    const min = Math.min(...times), max = Math.max(...times);
    return { min, max: max === min ? min + 1 : max };
  }, [messages, commits]);

  if (!range) return null;
  const pct = (t: string | number) => ((new Date(t).getTime() - range.min) / (range.max - range.min)) * 100;
  const cur = currentTs ? pct(currentTs) : 0;

  // Decimate ticks on huge sessions: keep every user dot visible up to 600,
  // thin AI/tool ticks to ~600 — commits always render.
  const users = messages.filter((m) => m.ts && m.kind === 'user');
  const others = messages.filter((m) => m.ts && m.kind !== 'user');
  const thin = <T,>(arr: T[], cap: number): T[] => arr.length <= cap ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / cap) === 0);
  const ticks = [...thin(users, 600), ...thin(others, 600)];

  function tsFromEvent(e: { clientX: number }): number {
    const rect = ref.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return range!.min + frac * (range!.max - range!.min);
  }

  function nudge(fraction: number) {
    const cur = currentTs ? new Date(currentTs).getTime() : range!.min;
    onSeek(Math.min(range!.max, Math.max(range!.min, cur + fraction * (range!.max - range!.min))));
  }

  return (
    <div className="timeline-wrap">
      <span className="muted small tl-time">{new Date(range.min).toLocaleTimeString()}</span>
      <div ref={ref} className="timeline" tabIndex={0} role="slider"
        aria-valuemin={range.min} aria-valuemax={range.max}
        aria-valuenow={currentTs ? new Date(currentTs).getTime() : range.min}
        onPointerDown={(e) => { setDragging(true); e.currentTarget.setPointerCapture(e.pointerId); onSeek(tsFromEvent(e)); }}
        onPointerMove={(e) => {
          const rect = ref.current!.getBoundingClientRect();
          setHover({ x: e.clientX - rect.left, ts: tsFromEvent(e) });
          if (dragging) onSeek(tsFromEvent(e));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => { setHover(null); setDragging(false); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-0.01); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(0.01); }
          else if (e.key === 'Home') { e.preventDefault(); onSeek(range.min); }
          else if (e.key === 'End') { e.preventDefault(); onSeek(range.max); }
        }}>
        <div className="tl-track" />
        {ticks.map((m) => (
          <span key={m.seq}
            className={`tick ${m.kind === 'user' ? 'tick-user' : 'tick-ai'}`}
            style={{ left: `${pct(m.ts as string)}%` }}
            title={`${m.kind} · ${new Date(m.ts as string).toLocaleTimeString()}`} />
        ))}
        {commits.map((c) => (
          <span key={c.hash} className={`tick tick-commit ${currentCommit?.hash === c.hash ? 'active' : ''}`}
            style={{ left: `${pct(c.date)}%` }}
            title={`⎇ ${c.subject} · ${new Date(c.date).toLocaleTimeString()}`} />
        ))}
        <span className="tl-cursor" style={{ left: `${cur}%` }} />
        {hover && (
          <span className="tl-hover" style={{ left: hover.x }}>
            {new Date(hover.ts).toLocaleTimeString()}
          </span>
        )}
      </div>
      <span className="muted small tl-time">{new Date(range.max).toLocaleTimeString()}</span>
    </div>
  );
}
