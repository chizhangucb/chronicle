// Ambient typing for gen-mini-session.mjs (plain JS by design — see its own
// header comment, same pattern as gen-big-session.d.mts). Only
// test/e2e/helpers.ts imports it from TypeScript; TS's NodeNext resolution
// looks up a `.d.mts` sibling for a `.mjs` import automatically.
export declare const MINI_DEFAULT_CWD: string;
export declare function writeMiniSession(
  destDir: string,
  opts: {
    sessionId: string;
    dateISO: string;
    promptText: string;
    cwd?: string;
    turns?: number;
    gapSec?: number;
    endISO?: string;
  }
): { sessionId: string; file: string };
