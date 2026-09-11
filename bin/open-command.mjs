// The command the launcher runs to hand a URL to the machine's default
// browser. Its own module, Node built-ins free, so it can be pinned by a unit
// test: bin/chronicle.mjs starts a server the moment it is imported, and the
// open itself is the one launch step a headless CI runner cannot observe
// (#200). Nothing here spawns; the caller does.

/**
 * Build the argv that opens `url` in the default browser on `platform`.
 *
 * @param {NodeJS.Platform | string} platform - a `process.platform` value.
 * @param {string} url - the dashboard URL to open.
 * @returns {{ command: string, args: string[] }} argv for `spawn`, URL as its own entry.
 */
export function browserOpenCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd.exe builtin, so it needs the shell to host it. Its first
  // quoted argument is the window TITLE, and the empty string is what stops the
  // URL being read as one, which is the classic Windows bug here.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  // Linux and every other Unix: the freedesktop opener.
  return { command: 'xdg-open', args: [url] };
}
