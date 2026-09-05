# ADR 0003: Redaction runs at the export boundary

**Status:** Accepted

## Context

Session transcripts contain secrets: keys pasted into a prompt, a connection string in a tool
result, a token in an error message. Chronicle can strip them at one of two moments.

**At ingest.** Scan on import and write redacted text into the database. The local store is
then clean by construction.

**At export.** Store the full transcript and redact when content leaves: the redacted
Markdown export, and the Security Check panel that shows what would be stripped.

Redacting at ingest destroys replay. A prompt with its key blanked is not the prompt the model
saw, and a tool result with a host blanked no longer explains the failure that followed. It is
also irreversible against a false positive: a regex that eats a UUID has eaten it for good,
and re-importing from the source log reproduces the same loss.

## Decision

The local database holds full content. Redaction runs at the export boundary
(`server/security.ts`), so replay is faithful and export is safe.

## Consequences

- Replay shows exactly what happened, including the secret that caused the incident.
- **`~/.chronicle/chronicle.db` is as sensitive as the source logs it was built from.** It is
  a local file on a machine the user already controls, and it is never uploaded, but it is not
  a sanitised artifact and must not be shared as one.
- A false-positive detector is a display bug, not data loss: fix the rule and export again.
- Redaction is one-way at the moment it runs, so the Security Check panel exists to let a user
  see the findings before producing the export.
- Every future path that emits content outward is a new boundary and must run the scanner.
  A path that emits content without redacting is a defect regardless of how convenient it is.
