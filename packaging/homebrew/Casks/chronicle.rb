cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.1"
  sha256 arm:   "e5504caee3bc83f86c0de920d0593f1eade3c27b25fbcb6fc93a0a44bf1550be",
         intel: "eac04902bc1ed9239e90176684a571c905d710c2b5292fc3ac60a6d1e70ab239"

  url "https://github.com/chizhangucb/homebrew-chronicle/releases/download/v#{version}/Chronicle-#{version}-#{arch}.dmg"
  name "Chronicle"
  desc "Local-first AI coding session time machine"
  homepage "https://github.com/chizhangucb/chronicle"

  app "Chronicle.app"

  zap trash: [
    "~/Library/Application Support/Chronicle",
    "~/.chronicle",
  ]

  caveats <<~EOS
    Chronicle is not code-signed or notarized yet, so macOS quarantines it on
    first launch. Either install with:
      brew install --cask chronicle --no-quarantine
    or clear the flag after installing:
      xattr -dr com.apple.quarantine "/Applications/Chronicle.app"
  EOS
end
