import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Kind } from '@shared/types.ts';

// A timeline dot/tick — the minimal fields the ruler reads off a normalized
// event. `seq` is always present by the time messages reach this component
// (assigned at insert/live-SSE time). `ts` is optional to match
// @shared/types.ts Event.ts (`ts?: string | null`) — some events genuinely
// have no timestamp, and PlaybackMessage (the type actually passed in) leaves
// the key absent rather than always setting it to `null`.
export interface TimelineMessage {
  seq: number;
  kind: Kind;
  ts?: string | null;
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
  // Whether the CURRENT `currentTs` was set via this Timeline's own
  // scrub/seek, vs some other path (message card click, window-jump
  // button). The parent (SessionView) overwrites this synchronously on
  // EVERY selection change, right alongside the state that produces
  // `currentTs` — so, unlike a locally-owned "did I just cause this" latch,
  // it can never go stale: it always reflects the true cause of the most
  // recent change, not a one-shot flag that a skipped effect run could fail
  // to reset.
  selectionFromTimeline?: boolean;
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
export default function Timeline({ messages, commits, currentTs, currentCommit, onSeek, selectionFromTimeline }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [dragging, setDragging] = useState(false);
  // The playhead's rendered position while/after a click or drag ON THIS
  // TRACK — a fraction 0..1, independent of which message ends up selected.
  //
  // Root cause this fixes: `onSeek` always resolves to the NEAREST
  // available message in time (seekTs in SessionView.tsx), which is
  // unavoidable — you can't select a message that doesn't exist. But real
  // sessions routinely have multi-hour gaps in activity (confirmed on
  // Chronicle's own repo session 2391e843: a genuine 5h48m pause), and
  // rendering the cursor at `pct(currentTs)` (the SELECTED message's own
  // timestamp) means every click anywhere inside such a gap collapses onto
  // whichever boundary message is nearest — a large, contiguous span of the
  // track visually "stuck" regardless of where within it you click/drag.
  // Tracking the raw interaction position instead makes the playhead follow
  // the pointer across the WHOLE track, exactly like a normal scrubber;
  // `scrubFrac` is cleared (falling back to the selected message's actual
  // position) whenever the selection changes some OTHER way — e.g. clicking
  // a message card in the chat pane. That "some other way" check reads the
  // `selectionFromTimeline` PROP (see its doc comment) rather than a ref
  // this component owns itself — an earlier version used a local
  // `selfCausedRef` boolean set in `seek()`, but that latch only got reset
  // when THIS effect fired, which only happens when `currentTs` actually
  // changes. A seek that resolves to the already-selected message (two
  // clicks in the same dead zone, or most drags) never changes `currentTs`,
  // so the effect never fires and never resets the flag — it leaks `true`
  // into the NEXT, genuinely external, selection change, which then wrongly
  // keeps the stale `scrubFrac` and freezes the playhead. Reading a prop the
  // parent overwrites unconditionally on every selection avoids that: there
  // is nothing to "consume", so nothing can go stale.
  const [scrubFrac, setScrubFrac] = useState<number | null>(null);

  const range: Range | null = useMemo(() => {
    const times = messages.map((m) => m.ts).filter((v): v is string => Boolean(v)).map((ts) => new Date(ts).getTime());
    for (const c of commits) times.push(new Date(c.date).getTime());
    if (!times.length) return null;
    const min = Math.min(...times), max = Math.max(...times);
    return { min, max: max === min ? min + 1 : max };
  }, [messages, commits]);

  // currentTs changing while `selectionFromTimeline` is false means the
  // selection moved via some other path — defer back to the newly selected
  // message's own position.
  useEffect(() => {
    if (!selectionFromTimeline) setScrubFrac(null);
  }, [currentTs, selectionFromTimeline]);

  if (!range) return null;
  const pct = (t: string | number) => ((new Date(t).getTime() - range.min) / (range.max - range.min)) * 100;
  // The fraction the playhead should sit at right now: the raw scrub
  // position if one is active, else wherever the selected message's own
  // timestamp falls. Shared by the rendered cursor and `nudge` (arrow keys)
  // so both agree on "where are we right now".
  function curFrac(): number {
    if (scrubFrac !== null) return scrubFrac;
    if (!currentTs) return 0;
    return (new Date(currentTs).getTime() - range!.min) / (range!.max - range!.min);
  }
  const cur = curFrac() * 100;

  // Decimate ticks on huge sessions: keep every user dot visible up to 600,
  // thin AI/tool ticks to ~600 — commits always render.
  const users = messages.filter((m) => m.ts && m.kind === 'user');
  const others = messages.filter((m) => m.ts && m.kind !== 'user');
  const thin = <T,>(arr: T[], cap: number): T[] => arr.length <= cap ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / cap) === 0);
  const ticks = [...thin(users, 600), ...thin(others, 600)];

  function fracFromEvent(e: { clientX: number }): number {
    const rect = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  // The one path every click/drag/keyboard seek on this track goes through:
  // records the raw fraction for the playhead AND tells the parent which
  // timestamp to resolve a message for.
  function seek(frac: number): void {
    setScrubFrac(frac);
    onSeek(range!.min + frac * (range!.max - range!.min));
  }

  function nudge(fraction: number) {
    seek(Math.min(1, Math.max(0, curFrac() + fraction)));
  }

  return (
    <div className="timeline-wrap">
      <span className="muted small tl-time">{new Date(range.min).toLocaleTimeString()}</span>
      <div ref={ref} className="timeline" tabIndex={0} role="slider"
        aria-valuemin={range.min} aria-valuemax={range.max}
        aria-valuenow={currentTs ? new Date(currentTs).getTime() : range.min}
        onPointerDown={(e) => { setDragging(true); e.currentTarget.setPointerCapture(e.pointerId); seek(fracFromEvent(e)); }}
        onPointerMove={(e) => {
          const rect = ref.current!.getBoundingClientRect();
          const frac = fracFromEvent(e);
          setHover({ x: e.clientX - rect.left, ts: range.min + frac * (range.max - range.min) });
          if (dragging) seek(frac);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => { setHover(null); setDragging(false); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-0.01); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(0.01); }
          else if (e.key === 'Home') { e.preventDefault(); seek(0); }
          else if (e.key === 'End') { e.preventDefault(); seek(1); }
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
