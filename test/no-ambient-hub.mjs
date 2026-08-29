// Hermetic hub environment for the node test suite (CHI-393).
//
// resolveHub() (server/hub/resolve.ts) resolves a hub from, in order,
// CHRONICLE_HUB -> AIOS_HUB -> config.json hubRoot. The "absent hub" tests
// simulate no-hub by deleting CHRONICLE_HUB, but a dev machine that exports
// AIOS_HUB (pointing at the real nisse hub) then falls through to it, so those
// tests saw a LIVE hub and failed locally while CI (no AIOS_HUB) stayed green.
//
// Clear both ambient hub-path vars once, before any test runs, so the suite is
// hermetic w.r.t. the machine it runs on. Tests that want a live hub set
// CHRONICLE_HUB explicitly in their own setup, which still takes precedence.
// Loaded via `node --import` in the `test` script so it applies to every worker.
delete process.env.AIOS_HUB;
delete process.env.CHRONICLE_HUB;
