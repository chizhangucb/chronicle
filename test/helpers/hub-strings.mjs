// One definition of "this names Chi's hub checkout", shared by the repo-shape
// pins (test/repo-shape.test.mjs) and the LiteLLM runtime pins
// (test/litellm-runtime.test.mjs). Two copies drifted apart once already: the
// runtime copy did not catch `scripts/litellm/`, so live hub paths sat in
// litellm/product-contract.md while its guard test passed (issue #186).
//
// PATHS is the set every guarded file must be clean of. LEGACY_LAYOUT is the
// pre-restructure layout of files that now live at the repo root; only the
// callers that own those files check it.

/** Hub checkout paths and the machine-only dirs the runtime used to reach. */
export const HUB_PATHS = /chizhang-2|AIOS_HUB|\.aios\/|\.secrets\//i;

/** The hub's own folders, named as a path a reader could follow. */
export const HUB_FOLDERS = /governance\//i;

/** Where these files used to live inside the hub, plus test paths that moved
 *  with them. A doc still citing `scripts/litellm/config.yaml` is pointing at
 *  a file that is not there. */
export const LEGACY_LAYOUT = /scripts\/litellm|scripts\/tests\/test_(litellm|lane_c)/i;

/** `hub `scripts/...`` style location headers. */
export const HUB_LOCATION = /\bhub\s+`/i;
