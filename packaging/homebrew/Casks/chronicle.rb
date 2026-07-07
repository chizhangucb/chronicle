cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.3"
  sha256 arm:   "60de6df9c9ac0e7f761ef124bdcc62547e6d8e1c44f5516c1d9cbd8c62a778a6",
         intel: "64f11b26e5dd75524f99b755fdca89787c559a8757232ed08e52f2199ad93fc7"

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
