cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.1"
  sha256 arm:   "7ffe18007ff317c1348bf2697232042b05b7332cf88ee0327a8d9a15f3f0d764",
         intel: "2085425f9433005262537d3ac857597d75e60b983433cd4b899ffb69d2c38a9e"

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
