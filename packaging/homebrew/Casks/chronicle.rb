cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.6"
  sha256 arm:   "4a8ecd0b7d08600f473772c95789cd9780c82dedeea7a815e7360ed49c0bd3c3",
         intel: "33725b8281e9ad35b6233c6514796851fe9ced15d45086383012ee8f8efc7db9"

  url "https://github.com/chizhangucb/homebrew-chronicle/releases/download/v#{version}/Chronicle-#{version}-#{arch}.dmg"
  name "Chronicle"
  desc "Local-first AI coding session time machine"
  homepage "https://github.com/chizhangucb/chronicle"

  app "Chronicle.app"

  zap trash: [
    "~/Library/Application Support/Chronicle",
    "~/.chronicle",
  ]
end
