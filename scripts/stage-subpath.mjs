#!/usr/bin/env node
/*
 * Stages the assembled build the way it is served: the site and the app each at the root of an
 * origin of their own, and the old front door under /draft-canvas/, where GitHub Pages serves it.
 *
 * Every build uses relative URLs, so in principle where it is served should not matter — and
 * checking that it actually does not is the point of staging the old address under its real prefix
 * rather than trusting a preview at the root. A root preview passes happily while every asset
 * reference is wrong by one directory; this one does not.
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
mkdirSync(join(preview, 'legacy', 'draft-canvas'), { recursive: true });
cpSync(join(built, 'site'), join(preview, 'site'), { recursive: true });
cpSync(join(built, 'app'), join(preview, 'app'), { recursive: true });
cpSync(join(built, 'legacy'), join(preview, 'legacy', 'draft-canvas'), { recursive: true });

console.log('stage-subpath: staged .preview-web/{site,app,legacy/draft-canvas}');
