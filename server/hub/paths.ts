import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/** The installed package root: walk up from this module until a package.json is
 * found. Robust across dev (server/hub/) and the published dist-server/ layout
 * (their depths to the package root differ), so shipped data files resolve the
 * same way in both. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return dir;
}

const DATA_DIR = process.env.CHRONICLE_DATA_DIR || join(os.homedir(), '.chronicle');

/** The safety-gaps register: an operator override at <dataDir>/safety-gaps.json
 * wins; otherwise the shipped synthetic-safe default at <package>/data/. */
export function safetyGapsRegisterPath(): string {
  const override = join(DATA_DIR, 'safety-gaps.json');
  return existsSync(override) ? override : join(packageRoot(), 'data', 'safety-gaps.json');
}
