import { useCallback, useRef, useState } from 'react';
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
// mousedown, so it never needs the element's box offset.

export type ResizeEdge = 'left' | 'right';

export interface Resizable {
  width: number;
  onHandleMouseDown: (e: React.MouseEvent) => void;
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
  // Latest committed width, so the mouseup handler can persist without a stale
  // closure and without a localStorage write on every mousemove tick.
  const latest = useRef<number>(width);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    // Stop the drag from starting a text selection or a click/navigation on the
    // underlying panel (the handle overlays a nav button / project row edge).
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = latest.current;

    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - startX;
      const next = clamp(edge === 'right' ? startW + delta : startW - delta, min, max);
      latest.current = next;
      setWidth(next);
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      writeStored(storageKey, latest.current);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Body class suppresses text selection + the panel width transition and
    // forces the col-resize cursor for the whole drag (see styles.css).
    document.body.classList.add('resizing');
  }, [storageKey, min, max, edge]);

  return { width, onHandleMouseDown };
}
