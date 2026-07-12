cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.10"
  sha256 arm:   "4add864be93a63e19e6486d365012a727f8d53ebbbce1745b02d083f68464bfc",
         intel: "f94195a7e800ec9fb11bb540211ccf0d2eaebde0330e90f2d96df21f34446bc3"

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
