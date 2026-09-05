# ADR 0008: Chronicle reads only its own folder, the source transcripts and the operator's repos

**Status:** Accepted

## Context

Chronicle sits on a machine full of other tools. It already knows where the coding tools keep
their transcripts, it already shells out to git, and it already runs a local server. Every one
of those is a foothold for a bigger job: schedule the sync as a system job, gate a tool's
network egress, launch a terminal in a project, read a sibling project's config so the two
agree. Chronicle grew several of those surfaces and then removed them again (the ops surfaces,
the external-checkout adapter, the terminal launcher, the proxy spend lane).

The pull is real, because each addition is individually reasonable. What it costs is the thing
that makes Chronicle safe to install: an operator can say exactly what it touches.

## Decision

Chronicle is a session-analysis tool and nothing else. It reads exactly three things:

- its own data folder (`~/.chronicle`, or `$CHRONICLE_DATA_DIR`), the only place it writes;
- the source tools' transcripts, read-only;
- the operator's git repos, read-only, through the queries ADR 0002 allows.

Nothing else. No file belonging to another project, no other project's configuration. It does
not schedule jobs, gate egress, or launch other programs. No env var or config key names a path
outside those three.

Two hard floors follow, and are never traded away:

- **No telemetry, ever.** Chronicle never phones home. The view log is local and stays local.
- **Never mutate a source transcript.** Chronicle only ever reads them.

Current posture, which is a default rather than a floor: the server binds loopback only
(`127.0.0.1`); no model call sits in the analysis path; the one model run is Ask, off by
default (ADR 0007); the one outbound call is the Claude plan-window quota read to
`api.anthropic.com`, on by default and off with a Settings toggle. Codex plan windows are read
locally.

Direction of data is one-way: any future integration with another tool is that tool reading
Chronicle's data, never Chronicle reading that tool's files.

## Consequences

- An operator can answer "what does this touch?" from three lines, and an audit is tractable.
- Features that would be genuinely useful get declined: cross-tool config awareness, running a
  sync as a system job, doing anything about what a coding tool spends. A proposal that needs a
  fourth read path contradicts this ADR and has to say so.
- Because there is no telemetry, Chronicle learns nothing about how it is used beyond what its
  own operator reports. Product decisions are made without usage data, on purpose.
- The quota read is the one thing a fully-offline operator has to turn off, so it stays a
  single visible toggle rather than a buried default.
- Reaching online-platform scale would reopen identity, opt-in external telemetry and a native
  shell. That is a new product, and it starts by superseding this ADR, not by relaxing it.
