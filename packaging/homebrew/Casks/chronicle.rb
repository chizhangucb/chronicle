cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.7"
  sha256 arm:   "975a8aa5290450e301e66dbebe8374d8dece956c7b62b5656d8c235113063147",
         intel: "f8e2b719f57639bf8b8f89fd3790d08178f5697e49ffa22daea648739414dbed"

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
