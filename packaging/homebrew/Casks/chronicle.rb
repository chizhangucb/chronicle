cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.5"
  sha256 arm:   "75d319efb1c3ace12bb56e100e640fb13da29021d9233f032bcc9435e51c57f2",
         intel: "b7550d54cb180dc544282106155c8b844f9de7e3c9b79735b34e8388178451de"

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
