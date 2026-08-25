// Ambient declaration for walk.mjs's one exported function, so
// walk-probes.spec.ts can import it under `tsc -b`'s strict project setup
// without turning walk.mjs itself (a standalone CLI script, deliberately
// free of the project's .ts build step) into a checked TypeScript file.
import type { Page } from '@playwright/test';

export interface PopoverClipResult {
  present: boolean;
  pass: boolean;
  notTestable?: boolean;
  note?: string;
  triggerBox?: unknown;
  bubbleBox?: unknown;
  insideLeft?: boolean;
  insideRight?: boolean;
  opensDown?: boolean;
}

export function probePopoverClip(page: Page, width: number): Promise<PopoverClipResult>;
