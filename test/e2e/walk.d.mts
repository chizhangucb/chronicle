// Ambient declaration for walk.mjs's exported functions, so a spec (or a
// node --test suite) can import them under `tsc -b`'s strict project setup
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

export interface LoadingOffender {
  tag: string;
  class: string;
  text: string;
}

export interface SettleResult {
  settled: boolean;
  networkIdle: boolean;
  waitedMs: number;
  tolerated: LoadingOffender[];
  /** Only on a failed settle (read off the thrown error). */
  blocking?: LoadingOffender[];
}

export interface WalkRoute {
  slug: string;
  /** Selectors whose "Loading…" is disclosed rather than blocking. */
  allowLoadingIn?: string[];
  setup(page: Page, notes?: string[]): Promise<void>;
}

export const WIDTHS: number[];

/** Source string for the browser-side RegExp that spots a loading placeholder. */
export const LOADING_PATTERN: string;

export function waitForLoadSettle(
  page: Page,
  options?: { timeoutMs?: number; pollMs?: number; allowLoadingIn?: string[]; notes?: string[] },
): Promise<SettleResult>;

/** Runs in the browser via page.evaluate; declared here for callers, not for TS to run. */
export function collectLoadingOffenders(
  options?: { allowSelectors?: string[]; pattern?: string },
): { blocking: LoadingOffender[]; tolerated: LoadingOffender[] };

export function capturePage(
  page: Page,
  route: WalkRoute,
  options: {
    width: number;
    screenshotPath: string;
    settleNotes?: string[];
    settleTimeoutMs?: number;
    settlePollMs?: number;
  },
): Promise<{ probes: unknown; settle: SettleResult }>;

export function buildRoutes(base: string, ctx: { projectId: unknown; sessionId: unknown; notes: string[] }): WalkRoute[];

export function summarize(pages: unknown[]): {
  totalPages: number;
  renderedOk: number;
  renderedError: number;
  loadSettle: { settled: number; toleratedLoading: number; neverSettled: number };
  byProbe: Record<string, { pass: number; fail: number; notTestable?: number }>;
};
