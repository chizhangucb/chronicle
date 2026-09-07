# ADR 0008: Chronicle reads only its own folder, the source transcripts and the operator's repos

Chronicle already knows where every coding tool keeps its transcripts, shells out to git and runs a local server, and each of those is a foothold for a bigger job. It grew several (ops surfaces, an external-checkout adapter, a terminal launcher, a proxy spend lane) and removed them again. What they cost is the thing that makes Chronicle safe to install: an operator can say exactly what it touches.

Chronicle is a session-analysis tool and reads exactly three things: its own data folder (`~/.chronicle` or `$CHRONICLE_DATA_DIR`, the only place it writes), the source tools' transcripts read-only, and the operator's git repos read-only through the queries ADR 0002 allows. It schedules no jobs, gates no egress, launches no programs, and no env var or config key names a path outside those three. Data flows one way: another tool may read Chronicle's data; Chronicle never reads that tool's files.

Two floors, never traded away:

- No telemetry, ever.
- Never mutate a source transcript. Chronicle only reads them.

The promise, stated precisely: session data never leaves the machine, and Chronicle has no server of its own. Current posture, a default rather than a floor: loopback only (`127.0.0.1`); no model call in the analysis path; the one model run is Ask, off by default (ADR 0007); the one outbound call is the Claude plan-window quota read, which sends the operator's own OAuth token to its own issuer for the operator's own quota, the same call Claude Code makes. On by default, off with a Settings toggle. Codex plan windows are read locally.

## Consequences

- "What does this touch?" is answered from three lines, and an audit is tractable.
- Useful features get declined: cross-tool config awareness, sync as a system job, anything about what a coding tool spends. A proposal needing a fourth read path contradicts this ADR and says so.
- Product decisions are made without usage data, on purpose.
- The quota read is the one thing a fully-offline operator turns off, so it stays a single visible toggle.
- Online-platform scale reopens identity, opt-in telemetry and a native shell. That is a new product, and it starts by superseding this ADR.
