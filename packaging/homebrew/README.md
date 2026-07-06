# Homebrew tap for Chronicle

[Chronicle](https://github.com/chizhangucb/chronicle) — local-first AI coding session time machine.

## Install

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle --no-quarantine
```

`--no-quarantine` is recommended because the app is not yet code-signed/notarized.
Without it, clear the quarantine flag manually after install:

```bash
xattr -dr com.apple.quarantine "/Applications/Chronicle.app"
```

## Upgrade

```bash
brew update && brew upgrade --cask chronicle
```

DMGs for each release are attached to this repository's
[Releases](https://github.com/chizhangucb/homebrew-chronicle/releases).
