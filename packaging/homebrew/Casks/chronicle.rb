cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.4"
  sha256 arm:   "814dd2e4fdbaf7c5921df3b1eac2af186c6785136ff6e3e18badb856918511a4",
         intel: "62742ccdd3b0837c42ac84465ac2b4470eeaaf29b9c4cb34a8023fe6a588f1a0"

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
