# ADR 0003: Redaction runs at the export boundary

The local database holds full content and redaction runs where content leaves (`server/security.ts`: the redacted export and the Security Check panel). Redacting at ingest was rejected because it destroys playback (the prompt with its key blanked is not the prompt the model saw) and makes every false positive permanent, since re-importing reproduces the same loss.

## Consequences

- `~/.chronicle/chronicle.db` is as sensitive as the source logs. Local and never uploaded, but never a sanitised artifact.
- A false-positive detector is a display bug: fix the rule and export again.
- Every path that emits content outward is a boundary and runs the scanner. A path that skips it is a defect, whatever the convenience.
