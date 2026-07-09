# Homebrew tap for Chronicle

[Chronicle](https://github.com/chizhangucb/chronicle) — local-first AI coding session time machine.

## Install

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

Builds are signed with an Apple Developer ID and notarized, so they open with no
Gatekeeper warning — no `--no-quarantine` flag needed.

## Upgrade

```bash
brew update && brew upgrade --cask chronicle
```

The app also updates itself: once installed, a new signed release downloads in the
background and offers a one-click **Relaunch to update**.

DMGs for each release are attached to this repository's
[Releases](https://github.com/chizhangucb/homebrew-chronicle/releases).
