#!/usr/bin/env python3
"""Confidentiality guard for CI (CHI-353).

The server-side merge gate for this public satellite: it fails the build (exit 1)
if a tracked file leaks an owner absolute home path or a committed secret shape
(API key / token / private-key block), or if `.gitignore` stops covering the
local-only secret/config files. Green + exit 0 when clean.

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

# Deliberate synthetic fixtures that embed FAKE secret shapes to test the
# safety machinery. Excused from the secret-shape check ONLY (home-path scanning
# still applies). A new such fixture is a visible, reviewed addition here.
SECRET_SCAN_WHITELIST = ("test/hub-safety.test.mjs",)

# `.gitignore` must keep covering the local-only secret/config surfaces.
REQUIRED_GITIGNORE = (".env", ".claude/settings.local.json")

# Files that legitimately CARRY leak-shaped strings because they document the
# guard itself (matched as a path prefix / exact path).
SELF_EXCLUDED_FILES = {
    "scripts/confidentiality_guard.py",
    "scripts/tests/test_confidentiality_guard.py",
}

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
    check_gitignore(root, findings)
    return findings


def main(root=None):
    root = os.path.abspath(root or os.environ.get("GUARD_ROOT") or os.getcwd())
    findings = run_checks(root)
    print(f"# Confidentiality guard, root: {root}")
    if not findings:
        print("clean: no leaked home paths or secret shapes; "
              ".gitignore covers local secrets.")
        return 0
    print(f"# {len(findings)} finding(s):\n")
    for f in findings:
        print(f"[BLOCK] {f}")
    print("\nguard failed: fix the above before this can merge.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
