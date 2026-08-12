import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

// Shared drag-to-resize primitive for the two app rails (left sidebar in
// App.tsx, right Home project rail in HomePage.tsx). Mirrors the sidebar
// collapse's localStorage-persistence pattern (App.tsx `chronicle-sidebar`):
// read once on mount, write on change. All storage access is guarded so the
// module stays clean under `tsc` and any SSR/server import path.
//
// `edge` says which side of the handle the resized panel sits on: a `'right'`
// handle (panel on the LEFT, e.g. the sidebar) grows as the cursor moves right;
// a `'left'` handle (panel on the RIGHT, e.g. the Home rail) grows as the
// cursor moves left. Width is derived from the drag DELTA off the width at
// pointerdown, so it never needs the element's box offset.
//
// The drag uses POINTER events with pointer capture (not mouse events) so the
// teardown is robust to three otherwise-uncovered exit paths:
//   1. Release OUTSIDE the OS window (multi-monitor, over the taskbar, a fast
//      drag past the edge): window listeners cover the viewport, not a release
//      outside the OS window — but `setPointerCapture` guarantees `pointerup`/
//      `pointercancel` still fire, so listeners + `body.resizing` get cleared.
//   2. Owning component unmounts mid-drag (the Home rail unmounts on nav): the
//      `useEffect` cleanup below tears down any in-flight drag on unmount.
//   3. A missed release for any reason: `pointermove` self-heals by ending the
//      drag as soon as it sees no button pressed (`e.buttons === 0`).

export type ResizeEdge = 'left' | 'right';

export interface Resizable {
  width: number;
  onHandlePointerDown: (e: React.PointerEvent<HTMLElement>) => void;
}

export interface ResizableOptions {
  storageKey: string;
  fallback: number;
  min: number;
  max: number;
  edge: ResizeEdge;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function readStored(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return fallback;
    return clamp(n, min, max);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable (private mode / quota) — width just won't persist */
  }
}

export function useResizable({ storageKey, fallback, min, max, edge }: ResizableOptions): Resizable {
  const [width, setWidth] = useState<number>(() => readStored(storageKey, fallback, min, max));
  // Latest committed width, so the drag's end handler can persist without a
  // stale closure and without a localStorage write on every pointermove tick.
  const latest = useRef<number>(width);
  // Teardown for the CURRENT drag, or null when idle. Lets the unmount effect
  // end an in-flight drag (hole #2). Nulled the moment a drag ends, so a later
  // unmount is a no-op.
  const activeTeardown = useRef<(() => void) | null>(null);

  const onHandlePointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // Stop the drag from starting a text selection or a click/navigation on the
    // underlying panel (the handle overlays a nav button / project row edge).
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = latest.current;
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    // Pointer capture routes every subsequent event for this pointer through
    // the handle (which bubbles to the window listeners below) even when the
    // release happens outside the OS window — closing hole #1.
    try { handle.setPointerCapture(pointerId); } catch { /* capture unsupported — window listeners still cover the viewport */ }

    function end() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      document.body.classList.remove('resizing');
      activeTeardown.current = null;
    }
    function onEnd() {
      end();
      writeStored(storageKey, latest.current);
    }
    function onMove(ev: PointerEvent) {
      // Self-heal (hole #3): a release we never saw leaves no button pressed.
      if (ev.buttons === 0) { onEnd(); return; }
      const delta = ev.clientX - startX;
      const next = clamp(edge === 'right' ? startW + delta : startW - delta, min, max);
      latest.current = next;
      setWidth(next);
    }

    activeTeardown.current = onEnd;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    // Body class suppresses text selection + the panel width transition and
    // forces the col-resize cursor for the whole drag (see styles.css).
    document.body.classList.add('resizing');
  }, [storageKey, min, max, edge]);

  // Unmount safety (hole #2): if the component unmounts mid-drag, end the drag
  // — removes the window listeners, releases capture, clears `body.resizing`,
  // and persists the in-progress width. No-op when idle.
  useEffect(() => () => { activeTeardown.current?.(); }, []);

  return { width, onHandlePointerDown };
}
