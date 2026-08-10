cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.2.1"
  sha256 arm:   "6af24dc6cfefc0c3f3ee57c3f49c9d45cbd704852a4d33282065108a48993f61",
         intel: "93ceec5ce34ec5b1f3584cd712e537355f5ce5756f80994f42d4ac1566888e87"

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
