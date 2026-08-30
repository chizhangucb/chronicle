#!/usr/bin/env python3
"""Confidentiality guard for CI (CHI-353).

The server-side merge gate for this public satellite: it fails the build (exit 1)
if a tracked file leaks an owner absolute home path, a committed secret shape
(API key / token / private-key block), or a machine-specific identifier, or if
`.gitignore` stops covering the local-only secret/config files. Green + exit 0
when clean.

One check is LOCAL-ONLY by design (CHI-416): comparing tracked files against
the live hub's structural config values needs a hub, which CI does not have, so
it runs on a developer machine and silently skips in CI. That split follows the
same principle as the paragraph below: what CI can enumerate is what is safe to
write down publicly.

Deterministic, read-only, stdlib only (runs on a bare CI python3, no deps). It
covers what is SAFE to enumerate in a public repo: generic leak shapes that name
nothing owner-specific. The owner's confidential VOCABULARY (names, venture and
wiki slugs, deal markers) and the high-entropy heuristic stay CLIENT-SIDE in the
hub egress gate: enumerating that vocabulary here would itself leak, and entropy
false-positives on lockfiles. So this is a backstop, not the whole scan.

Note: unlike nisse's clean-skeleton guard, this active satellite deliberately
references hub ticket ids (CHI-NNN) in its own docs/commits, so a tracker-id
check does NOT belong here (it is not a leak, and would block every merge).

Run from the repo root:  python3 scripts/confidentiality_guard.py
Override the scanned root with $GUARD_ROOT or main(root=...).
"""
import json
import os
import re
import subprocess
import sys

# Owner absolute home path (NOT the bare handle: `chizhang` is the public GitHub
# identity and shows up in legit tokens; only a home-dir prefix is a leak).
HOME_PATH_RE = re.compile(r"[/\\](?:Users|home)[/\\]chizhang(?![\w-])")

# Committed-secret shapes: an accidentally-pasted real credential is the worst
# thing that can land in a public repo. Generic key/token shapes, safe to
# enumerate publicly.
SECRET_SHAPES = tuple(re.compile(p) for p in (
    r"\bsk-[A-Za-z0-9_-]{16,}",
    r"\bgh[pousr]_[A-Za-z0-9]{16,}",
    r"\bAKIA[0-9A-Z]{16}\b",
    r"\bxox[baprs]-[A-Za-z0-9-]+",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}",  # JWT (2+ segments)
))

# Machine-specific identifier shapes that are NEVER legitimate in this repo
# (CHI-416). Deliberately narrow. The bare handle is NOT here, for the reason
# HOME_PATH_RE gives: it is the public GitHub identity and appears in
# FUNDING.yml, the workflows, the website and package.json. The hub DIRECTORY
# name is not here either: it is the documented `AIOS_HUB` default and appears
# legitimately in shipped code (scripts/emit-daily-digest.ts).
#
# A launchd reverse-DNS label under the owner's namespace has no such excuse:
# it names one machine's private jobs, means nothing to any other user, and is
# what leaked in CHI-329 (a protected-jobs list hardcoded from this machine).
MACHINE_ID_SHAPES = (
    (re.compile(r"\bcom\.chizhang\.[A-Za-z0-9._-]+"),
     "owner launchd job label (names one machine's private jobs)"),
)

# Deliberate synthetic fixtures that embed FAKE secret shapes to test the
# safety machinery. Excused from the secret-shape check ONLY (home-path scanning
# still applies). A new such fixture is a visible, reviewed addition here.
SECRET_SCAN_WHITELIST = ("test/hub-safety.test.mjs",)

# `.gitignore` must keep covering the local-only secret/config surfaces.
REQUIRED_GITIGNORE = (".env", ".claude/settings.local.json", "__pycache__")

# Files that legitimately CARRY leak-shaped strings because they document the
# guard itself (matched as a path prefix / exact path).
SELF_EXCLUDED_FILES = {
    "scripts/confidentiality_guard.py",
    "scripts/tests/test_confidentiality_guard.py",
}

# Binary fixtures that MUST be tracked because the importer reads that format
# (Cursor keeps sessions in a SQLite state db, OpenCode in its own). The guard
# cannot see inside them, so each is a reviewed, named exception rather than a
# blanket suffix skip: adding one is a visible decision, and whoever adds it is
# asserting the contents are synthetic.
BINARY_FIXTURE_ALLOWLIST = (
    "test/fixtures/cursor-user/globalStorage/state.vscdb",
    "test/fixtures/cursor-user/workspaceStorage/abc123/state.vscdb",
    "test/fixtures/oc-live.db",
)

SKIP_SCAN_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".pdf", ".ico", ".zip",
                      ".gz", ".woff", ".woff2", ".ttf", ".lock")


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def tracked_files(root):
    try:
        out = subprocess.run(["git", "-C", root, "ls-files", "-z"],
                             capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return None
        return [p for p in out.stdout.split("\0") if p]
    except (OSError, subprocess.SubprocessError):
        return None


def _scannable(rel):
    return rel not in SELF_EXCLUDED_FILES and not rel.endswith(SKIP_SCAN_SUFFIXES)


def check_lines(root, rels, findings):
    """Home paths and secret shapes, one pass over tracked text."""
    for rel in rels:
        if not _scannable(rel):
            continue
        text = read_text(os.path.join(root, rel))
        if text is None:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if HOME_PATH_RE.search(line):
                findings.append(f"absolute owner home path leaked at {rel}:{i}: "
                                f"{line.strip()[:80]}")
            if rel.startswith(SECRET_SCAN_WHITELIST):
                continue  # synthetic fixture: fake secret shapes are the point
            for rx in SECRET_SHAPES:
                if rx.search(line):
                    findings.append(f"committed secret shape leaked at {rel}:{i}: "
                                    f"{line.strip()[:80]}")
                    break


def check_machine_ids(root, rels, findings):
    """Identifier shapes that are never legitimate in a public package."""
    for rel in rels:
        if not _scannable(rel):
            continue
        text = read_text(os.path.join(root, rel))
        if text is None:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for rx, label in MACHINE_ID_SHAPES:
                if rx.search(line):
                    findings.append(f"{label} at {rel}:{i}: {line.strip()[:80]}")
                    break


# Hub config files whose STRING VALUES must never appear verbatim in this repo.
# Read from the live hub at scan time, never enumerated here: the guard's
# docstring is right that spelling the owner's vocabulary into a public file
# would itself be the leak. This is why the check is local-only.
HUB_VALUE_SOURCES = (
    "scripts/gating_policy.json",
    "scripts/egress_gate/data/classification.json",
)

# Confidential MARKER phrases are deliberately not a source here. They are
# ordinary English, indistinguishable from prose by any cheap filter, and the
# hub egress gate already scans outgoing content for them on every push. This
# guard covers the shapes that scan does not: structural config values.
#
# A hub value only counts as evidence of a copy when it is structurally
# config-shaped, meaning it carries a path, URL or regex character. Plain words
# like "conditioned-auto" or "confidentiality" appear in the hub AND
# legitimately all over this repo, and comparing those produces pure noise.
# Hub keys holding PUBLIC pointers: other public repo slugs, and paths to
# governance docs this repo legitimately cites in its own floor. Matching those
# is a cross-reference, not a copy.
HUB_VALUE_SKIP_KEYS = (
    "gating_policy.json.docs",
    "gating_policy.json.github",
    "gating_policy.json.satellites",
)

MIN_HUB_VALUE_LEN = 10
STRUCTURAL_CHARS = set("\\/*^$[]()?|")
PUBLIC_SELF = ("chronicle",)


def _hub_root():
    hub = os.environ.get("AIOS_HUB") or os.path.join(
        os.path.expanduser("~"), "chizhang-2")
    return hub if os.path.isdir(hub) else None


def _hub_string_values(obj, path, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            _hub_string_values(v, f"{path}.{k}", out)
    elif isinstance(obj, list):
        for n, v in enumerate(obj):
            _hub_string_values(v, f"{path}[{n}]", out)
    elif isinstance(obj, str):
        if (len(obj) >= MIN_HUB_VALUE_LEN
                and STRUCTURAL_CHARS & set(obj)
                and not any(p in obj.lower() for p in PUBLIC_SELF)):
            # A regex value decoded from JSON carries single backslashes, but
            # a JS/JSON fixture that copied it writes them DOUBLED. Comparing
            # only the decoded form misses the exact shape of the incident this
            # check exists for, so match either spelling.
            out.append(((obj, obj.replace("\\", "\\\\")), path))


def check_hub_values(root, rels, findings):
    """LOCAL-ONLY: no tracked file may reproduce a live hub config value.

    This is the check that would have caught CHI-416's second incident, where a
    hub config file was copied verbatim into a test fixture. It needs the hub,
    so it is a pre-push check on a machine that has one and a silent no-op in
    CI, which has none. That split is deliberate: the shapes CI can enumerate
    are the ones safe to write down publicly, and these are not.

    A finding never prints the value, only where it came from and where it
    landed. Printing it would put the thing we are protecting into a build log.
    """
    hub = _hub_root()
    if hub is None:
        return
    values = []
    for rel in HUB_VALUE_SOURCES:
        text = read_text(os.path.join(hub, rel))
        if text is None:
            continue
        try:
            _hub_string_values(json.loads(text), os.path.basename(rel), values)
        except ValueError:
            continue
    values = [(v, w) for v, w in values if not w.startswith(HUB_VALUE_SKIP_KEYS)]
    if not values:
        return
    for rel in rels:
        if not _scannable(rel):
            continue
        text = read_text(os.path.join(root, rel))
        if text is None:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for variants, where in values:
                if any(v in line for v in variants):
                    findings.append(
                        f"live hub config value reproduced at {rel}:{i} "
                        f"(from {where}); value withheld from this log")
                    break


def check_unscannable(root, rels, findings):
    """A tracked file the scanner CANNOT read is a blind spot, not a pass.

    read_text() returns None for anything that is not valid UTF-8 and
    check_lines silently skips it, so an undecodable tracked file is exempt
    from every check above. Images and fonts are expected and enumerated in
    SKIP_SCAN_SUFFIXES; anything else is a compiled or binary artifact that
    should not be tracked at all.

    This is not hypothetical (CHI-416): a tracked `__pycache__/*.pyc` embeds
    the ABSOLUTE path of the source it was compiled from, which is precisely
    what HOME_PATH_RE blocks in source, and it sailed through because the
    scanner could not decode it.
    """
    for rel in rels:
        if (rel in SELF_EXCLUDED_FILES or rel.endswith(SKIP_SCAN_SUFFIXES)
                or rel in BINARY_FIXTURE_ALLOWLIST):
            continue
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        if read_text(path) is None:
            findings.append(
                f"tracked file is not readable as text, so every check above "
                f"silently skips it: {rel}")


def check_gitignore(root, findings):
    text = read_text(os.path.join(root, ".gitignore"))
    if text is None:
        findings.append(".gitignore is missing; local data/config is unguarded")
        return
    lines = [ln.strip() for ln in text.splitlines()
             if ln.strip() and not ln.strip().startswith("#")]
    for needed in REQUIRED_GITIGNORE:
        if not any(needed in ln for ln in lines):
            findings.append(f".gitignore no longer covers '{needed}'")


def run_checks(root):
    findings = []
    rels = tracked_files(root)
    if rels is None:
        findings.append("git ls-files failed; not a git repo or git missing")
        return findings
    check_lines(root, rels, findings)
    check_machine_ids(root, rels, findings)
    check_hub_values(root, rels, findings)
    check_unscannable(root, rels, findings)
    check_gitignore(root, findings)
    return findings


def main(root=None):
    root = os.path.abspath(root or os.environ.get("GUARD_ROOT") or os.getcwd())
    findings = run_checks(root)
    print(f"# Confidentiality guard, root: {root}")
    if not findings:
        print("clean: no leaked home paths, secret shapes or machine ids; "
              ".gitignore covers local secrets."
              + ("" if _hub_root() else " (hub-value check skipped: no hub here)"))
        return 0
    print(f"# {len(findings)} finding(s):\n")
    for f in findings:
        print(f"[BLOCK] {f}")
    print("\nguard failed: fix the above before this can merge.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
