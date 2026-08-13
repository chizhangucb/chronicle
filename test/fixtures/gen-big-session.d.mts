// Ambient typing for gen-big-session.mjs (plain JS by design — see its own
// header comment). Only test/e2e/helpers.ts imports it from TypeScript;
// TS's NodeNext resolution looks up a `.d.mts` sibling for a `.mjs` import
// automatically, so this needs no `include`/module-declaration wiring.
export declare function generateBigSession(
  destDir: string,
  opts?: { seed?: number }
): { sessionId: string; mainFile: string; agentCount: number; totalMessages: number };
export declare const FIXTURE_SUBAGENT_COUNT: number;
export declare const FIXTURE_WORKFLOW_SUBAGENT_COUNT: number;
export declare const FIXTURE_DIRECT_SUBAGENT_COUNT: number;
export declare const FIXTURE_MAIN_MESSAGES: number;
