# Running Chronicle as an always-on local service

Chronicle is local-first: it reads your session history and local git repos on your machine, with zero outbound traffic. That also means it only works while it's running. If you want your Chronicle available at a stable URL all day (bookmarkable, survives reboots), run it as a login service instead of starting it by hand.

Do not deploy the Chronicle app to a hosting platform. It has no access to your local data from a server, and uploading session history would defeat the point of local-first.

## macOS (LaunchAgent)

Create `~/Library/LaunchAgents/com.<you>.chronicle.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.you.chronicle</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/chronicle</string>
    <string>--port</string>
    <string>41730</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/.chronicle/service.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.chronicle/service.log</string>
</dict>
</plist>
```

Adjust the `chronicle` path to `which chronicle`, pick any free port, then load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.chronicle.plist
```

Chronicle now starts at login, restarts automatically if it crashes (`KeepAlive`), and serves at `http://localhost:41730` for a bookmark. Logs land in `~/.chronicle/service.log`.

## Day-to-day commands

```sh
# restart (e.g. after upgrading chronicle-cli)
launchctl kickstart -k gui/$(id -u)/com.you.chronicle

# stop / start
launchctl bootout gui/$(id -u)/com.you.chronicle
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.chronicle.plist

# upgrade the CLI, then restart the service
npm i -g chronicle-cli@latest
launchctl kickstart -k gui/$(id -u)/com.you.chronicle
```

A tiny shell alias wrapping these (e.g. `chron restart`, `chron update`) saves remembering the `launchctl` incantations.

## Other platforms

Any process supervisor works; the service is just `chronicle --port <port> --no-open`.

- Linux: a systemd user unit with `Restart=always`.
- Windows: Task Scheduler with an "At log on" trigger.
