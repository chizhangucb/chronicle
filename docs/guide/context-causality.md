# Context causality

See what the AI *read* just before it *changed* something — a per-change list of likely source references, each with a confidence score, computed entirely on your machine.

When an AI edits a file, the interesting question is usually "what did it look at to decide that?" Context causality answers it by linking each `Write`/`Edit` back to the reads (`Read`, `Grep`, `Glob`, …) that preceded it, ranked by how likely each read actually informed the change. It's a **local structural heuristic** — `analyzeCausality()` in `server/causality.js`, no LLM anywhere — so it runs offline, instantly, and never sends your code off the machine. That's a deliberate trade: it reasons about *file relationships and ordering*, not semantics, and it's honest about its confidence rather than guessing.

## The ⛓ badge

In Playback, any change message that has candidate sources gets a **⛓ badge** in its header showing the source count. Click it to open a panel titled *"What likely drove this change"*. Each row is one source read, showing:

- a **confidence bar** and percentage,
- the **tool and file** the AI read (or the search pattern it ran),
- a short **reason** in plain English.

Click any source row to **jump to that message** in the transcript, so you can read exactly what the AI saw.

## How reads are matched to changes

For each change, Chronicle looks only at reads that happened *earlier in the session* (lower sequence number), then scores each one by its structural relationship to the changed file. The strongest relationship wins:

| Confidence | Relationship | Reason shown |
| --- | --- | --- |
| **0.95** | Read the exact file it then changed | "read this exact file before changing it" |
| **0.55** | Read a sibling file in the same directory | "read a sibling file in the same directory" |
| **0.50** | Read a different file with the same base name | "read a file with the same base name" |
| **0.45** | Ran a search whose pattern matches the changed file | "searched for '…'" |
| **0.20** | Read shortly before the change, no structural link | "read shortly before this change (background context)" |

The 0.20 tier only applies to reads inside a short temporal window (the last several reads before the change), which is why "read shortly before" is background context rather than direct evidence. Sources are de-duplicated per read, sorted strongest-first, and capped at the top few — so the panel leads with the exact-file match when there is one and tapers into weaker, contextual links.

In the panel, high-confidence sources (above 0.8) are styled as **direct** and low-confidence ones (below 0.3) as **background**, so a glance tells you whether the AI worked from the file it edited or from looser surrounding context.

## Why a heuristic, not a model

Chronicle makes no LLM calls anywhere — that's the offline, local-first guarantee. Causality could be sharper with a model reading the actual content, but that would mean shipping your code to an API, and Chronicle won't. The structural signals it uses (same file, same directory, same base name, matching search, recency) turn out to explain most real edits, and the confidence tiers keep the tool from overclaiming when the link is only circumstantial. Treat it as a fast, private "where did this come from?" pointer — not an oracle.

## Related

- [Time travel](./time-travel.md) — Playback mode, where the ⛓ badges live alongside the Git snapshot for each message.
- [Security, live & replay internals](../architecture/security-live-replay.md) — the internals of `server/causality.js` and Chronicle's other local heuristics.
