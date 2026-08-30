#!/usr/bin/env python3
"""Tests for the confidentiality guard (CHI-416).

Every case here is a REAL incident, not a hypothetical. Two separate sessions
put machine identifiers into this public repo within one hour on 2026-08-29,
and both passed the guard as it stood, because neither carried an absolute home
path. These pin the shapes so that cannot happen quietly again.

stdlib only, same constraint as the guard itself. Run:
    python3 scripts/tests/test_confidentiality_guard.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import confidentiality_guard as guard  # noqa: E402


def make_repo(files):
    """A throwaway git repo with `files` tracked (the guard reads git ls-files)."""
    root = tempfile.mkdtemp(prefix="guard-test-")
    subprocess.run(["git", "init", "-q", root], check=True)
    for rel, text in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    # .gitignore must cover the required entries or every case fails on that
    with open(os.path.join(root, ".gitignore"), "w", encoding="utf-8") as f:
        f.write(".env\n.claude/settings.local.json\n__pycache__/\n")
    subprocess.run(["git", "-C", root, "add", "-A"], check=True,
                   capture_output=True)
    return root


def findings_for(files, hub=None):
    root = make_repo(files)
    old = os.environ.get("AIOS_HUB")
    # Point the hub-value check at a controlled hub, or nowhere at all.
    os.environ["AIOS_HUB"] = hub if hub else os.path.join(root, "no-such-hub")
    try:
        return guard.run_checks(root)
    finally:
        if old is None:
            os.environ.pop("AIOS_HUB", None)
        else:
            os.environ["AIOS_HUB"] = old


class MachineIdentifiers(unittest.TestCase):
    """Incident 1: a machine's launchd labels hardcoded into shipped source."""

    def test_owner_launchd_label_in_source_is_blocked(self):
        f = findings_for({"server/gate/approval.ts":
                          "export const JOBS = ['com.chizhang.daily-maintenance'];\n"})
        self.assertTrue(any("launchd job label" in x for x in f), f)

    def test_the_finding_names_the_file_and_line(self):
        f = findings_for({"server/gate/approval.ts":
                          "// header\nconst x = 'com.chizhang.hygiene-fix';\n"})
        self.assertTrue(any("server/gate/approval.ts:2" in x for x in f), f)

    def test_a_third_party_reverse_dns_label_is_fine(self):
        # Only the owner's namespace is a machine identifier. Naming another
        # vendor's launchd label is ordinary.
        f = findings_for({"docs/guide.md": "Pause com.apple.Spotlight if needed.\n"})
        self.assertEqual(f, [])

    def test_the_bare_handle_stays_allowed(self):
        # Deliberate: it is the public GitHub identity and appears in
        # FUNDING.yml, the workflows, package.json and the website.
        f = findings_for({".github/FUNDING.yml": "github: [chizhangucb]\n"})
        self.assertEqual(f, [])

    def test_the_hub_directory_default_stays_allowed(self):
        # Also deliberate: it is the documented AIOS_HUB default and appears in
        # shipped code (scripts/emit-daily-digest.ts).
        f = findings_for({"scripts/x.ts": "return join(homedir(), 'chizhang-2');\n"})
        self.assertEqual(f, [])


class HubValues(unittest.TestCase):
    """Incident 2: a hub config file copied verbatim into a test fixture."""

    def setUp(self):
        self.hub = tempfile.mkdtemp(prefix="guard-hub-")
        os.makedirs(os.path.join(self.hub, "scripts"), exist_ok=True)
        with open(os.path.join(self.hub, "scripts", "gating_policy.json"),
                  "w", encoding="utf-8") as f:
            json.dump({
                "push_pins": {
                    "hub": {
                        "spool_refs": "refs/private/spool/*",
                        "scrub_whitelist": [r"\bsome-private-handle\b"],
                    },
                },
                # public pointers: cross-referencing these is not a copy
                "docs": {"human_source": "governance/action-gating.md"},
                "github": {"other": {"repo": "owner/other-public-repo"}},
            }, f)

    def test_a_copied_hub_value_is_blocked(self):
        f = findings_for({"test/fixture.mjs":
                          "const pin = { spool_refs: 'refs/private/spool/*' };\n"},
                         hub=self.hub)
        self.assertTrue(any("live hub config value reproduced" in x for x in f), f)

    def test_the_finding_never_prints_the_value(self):
        f = findings_for({"test/fixture.mjs":
                          "const pin = { spool_refs: 'refs/private/spool/*' };\n"},
                         hub=self.hub)
        self.assertTrue(f)
        joined = " ".join(f)
        self.assertNotIn("refs/private/spool", joined,
                         "a guard that prints the secret into the build log is worse than none")
        self.assertIn("withheld", joined)

    def test_a_copied_scrub_whitelist_regex_is_blocked(self):
        # The exact shape of incident 2.
        f = findings_for({"test/fixture.mjs":
                          "const w = ['\\\\bsome-private-handle\\\\b'];\n"},
                         hub=self.hub)
        self.assertTrue(any("live hub config value reproduced" in x for x in f), f)

    def test_public_pointers_are_not_copies(self):
        # A governance doc path and another public repo slug both appear in the
        # hub AND legitimately in this repo's own floor docs.
        f = findings_for({"CLAUDE.md": "See governance/action-gating.md\n",
                          "README.md": "Sibling: owner/other-public-repo\n"},
                         hub=self.hub)
        self.assertEqual(f, [])

    def test_plain_words_are_never_compared(self):
        # Hub config is full of ordinary English. Comparing it produces noise,
        # and marker phrases are the hub egress gate's job, not this guard's.
        with open(os.path.join(self.hub, "scripts", "gating_policy.json"),
                  "w", encoding="utf-8") as fh:
            json.dump({"push_pins": {"x": {"posture": "conditioned-auto"}}}, fh)
        f = findings_for({"docs/x.md": "Push is conditioned-auto here.\n"},
                         hub=self.hub)
        self.assertEqual(f, [])

    def test_no_hub_means_the_check_is_a_silent_no_op(self):
        # CI has no hub. The check must skip, not fail the build.
        f = findings_for({"test/fixture.mjs":
                          "const pin = { spool_refs: 'refs/private/spool/*' };\n"})
        self.assertEqual(f, [])


class UnscannableFiles(unittest.TestCase):
    """Incident 3: a tracked .pyc bypassed every check by being unreadable.

    read_text() returns None for non-UTF-8 and check_lines silently skips it,
    so an undecodable tracked file was exempt from the whole guard. A .pyc
    embeds the ABSOLUTE path of the source it was compiled from, which is
    exactly what HOME_PATH_RE blocks in source.
    """

    def test_a_tracked_binary_is_blocked_not_silently_skipped(self):
        root = make_repo({"src/x.ts": "ok\n"})
        os.makedirs(os.path.join(root, "scripts"), exist_ok=True)
        with open(os.path.join(root, "scripts", "cached.pyc"), "wb") as f:
            f.write(b"\x00\x01\xfe/Users/someone/secret/path.py\x00")
        subprocess.run(["git", "-C", root, "add", "-A"], check=True,
                       capture_output=True)
        os.environ["AIOS_HUB"] = os.path.join(root, "no-such-hub")
        f = guard.run_checks(root)
        self.assertTrue(any("not readable as text" in x for x in f), f)

    def test_expected_binary_types_stay_quiet(self):
        root = make_repo({"src/x.ts": "ok\n"})
        with open(os.path.join(root, "logo.png"), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n\x00binary")
        subprocess.run(["git", "-C", root, "add", "-A"], check=True,
                       capture_output=True)
        os.environ["AIOS_HUB"] = os.path.join(root, "no-such-hub")
        self.assertEqual(guard.run_checks(root), [])

    def test_gitignore_must_keep_covering_pycache(self):
        root = make_repo({"src/x.ts": "ok\n"})
        with open(os.path.join(root, ".gitignore"), "w", encoding="utf-8") as f:
            f.write(".env\n.claude/settings.local.json\n")  # no __pycache__
        subprocess.run(["git", "-C", root, "add", "-A"], check=True,
                       capture_output=True)
        os.environ["AIOS_HUB"] = os.path.join(root, "no-such-hub")
        f = guard.run_checks(root)
        self.assertTrue(any("__pycache__" in x for x in f), f)


class ExistingChecksStillHold(unittest.TestCase):
    def test_absolute_owner_home_path_still_blocks(self):
        f = findings_for({"src/x.ts": "const p = '/Users/chizhang/notes';\n"})
        self.assertTrue(any("home path" in x for x in f), f)

    def test_secret_shape_still_blocks(self):
        f = findings_for({"src/x.ts": "const k = 'sk-" + "a" * 20 + "';\n"})
        self.assertTrue(any("secret shape" in x for x in f), f)

    def test_missing_gitignore_entry_blocks(self):
        root = make_repo({"src/x.ts": "ok\n"})
        with open(os.path.join(root, ".gitignore"), "w", encoding="utf-8") as f:
            f.write("node_modules\n")
        subprocess.run(["git", "-C", root, "add", "-A"], check=True,
                       capture_output=True)
        os.environ["AIOS_HUB"] = os.path.join(root, "no-such-hub")
        self.assertTrue(any(".gitignore" in x for x in guard.run_checks(root)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
