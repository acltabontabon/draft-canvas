#!/usr/bin/env node
/*
 * Serves the assembled build the way GitHub Pages will: under /draft-canvas/, not at the root.
 *
 * Both halves use relative URLs, so in principle the prefix should not matter — and checking that
 * it actually does not matter is the entire point of staging it this way rather than trusting a
 * preview at the root. A root preview passes happily while every asset reference is wrong by one
 * directory; this one does not.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist-web');
const preview = join(root, '.preview-web');

if (!existsSync(built)) {
  console.error('stage-subpath: dist-web/ is missing — run `npm run build:web` first.');
  process.exit(1);
}

rmSync(preview, { recursive: true, force: true });
mkdirSync(join(preview, 'draft-canvas'), { recursive: true });
cpSync(built, join(preview, 'draft-canvas'), { recursive: true });

console.log('stage-subpath: staged at .preview-web/draft-canvas');
console.log('  landing page  http://localhost:4174/draft-canvas/');
console.log('  editor        http://localhost:4174/draft-canvas/editor/');
