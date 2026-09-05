# Architecture decisions

One file per decision that is hard to reverse, surprising to a newcomer, and bought with a
real trade-off. Everything else is a doc line, not an ADR: see
[`docs/contributing/architecture.md`](../contributing/architecture.md).

This directory is agent-only. It is excluded from the published docs build.

| ADR | Decision |
| --- | --- |
| [0001](0001-no-native-modules.md) | No native modules: `node:sqlite` and git via `execFile` |
| [0002](0002-git-is-the-only-code-state.md) | Git history is the only source of code state |
| [0003](0003-redaction-at-the-export-boundary.md) | Redaction runs at the export boundary |
| [0004](0004-flat-five-kind-event-model.md) | A flat five-kind event model is the ingestion contract |
| [0005](0005-server-ships-tokens-client-prices.md) | The server ships token cells; the client prices them |
| [0006](0006-token-calibration-by-text-share.md) | Per-bucket tokens are calibrated from text share |
| [0007](0007-ask-read-only-handle-is-the-boundary.md) | `/ask`: a read-only SQLite handle is the security boundary |

## Writing one

Status, Context, Decision, Consequences. Consequences carry the cost you accepted, not only
the benefit you wanted. When new work contradicts an ADR, say so in the PR rather than
quietly overriding it.
