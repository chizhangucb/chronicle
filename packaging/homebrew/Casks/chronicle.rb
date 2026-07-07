cask "chronicle" do
  arch arm: "arm64", intel: "x64"

  version "0.1.2"
  sha256 arm:   "d9d57b4ca3d425c8151d6784c123d7ab119be8ae85021e225524e186f5827f19",
         intel: "88228dbf0279af0f4403718bc1eb57a23d46fb56caa55a3c792bb680a0722704"

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
