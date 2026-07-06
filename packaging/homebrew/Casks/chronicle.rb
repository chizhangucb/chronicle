cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "0f78cbca2b2eb815b40864f9978ec1fddc656f8bfb963cbe66d9dfdb6df92902",
         intel: "cebbda8012bffc0e9cf4201956fd097ef4a11d274beba41b9e80a86a0b1960d7"

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
