cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.9"
  sha256 arm:   "152ea84b513f610efe229ef588dafee99f6bcb6e9d51d86781b4f65707ca84d0",
         intel: "ffe2ca296474f1fab4bdfa663f2778ae859553e3e37f70b5107b9e664fd721f5"

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
