// Combines the two halves of the site into one Vercel output directory (dist/):
//   /        → the static download landing page (index.html + assets/)
//   /docs/*  → the VitePress build (base '/docs/', emitted to .vitepress/dist)
// Run after `vitepress build`. Vercel serves `dist` (outputDirectory in vercel.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // website/
const VP_DIST = path.join(ROOT, '.vitepress', 'dist'); // VitePress output (built for /docs/)
const DIST = path.join(ROOT, 'dist'); // final combined output

if (!fs.existsSync(VP_DIST)) {
  console.error('[assemble] .vitepress/dist missing — run `vitepress build` first');
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// Docs → /docs
fs.cpSync(VP_DIST, path.join(DIST, 'docs'), { recursive: true });

// Landing → /
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
fs.cpSync(path.join(ROOT, 'assets'), path.join(DIST, 'assets'), { recursive: true });

console.log('[assemble] dist/ = landing (/) + docs (/docs/)');
