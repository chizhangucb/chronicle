cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.2.0"
  sha256 arm:   "d15fef67ae529a2801b7dd8c21e6f66ec8471ad01c69c676b08b16bf42e335c2",
         intel: "cdb94a9e53462d8b28a7696cd250229ccfeb3d2094c73f7b1bdc81d95b48bcdf"

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
