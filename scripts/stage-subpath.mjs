#!/usr/bin/env node
/*
 * Stages the assembled build the way it is served: the site and the app each at the root of an
 * origin of their own. (The name is from when the old address was also staged, under its
 * /draft-canvas/ prefix.)
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
mkdirSync(preview, { recursive: true });
cpSync(join(built, 'site'), join(preview, 'site'), { recursive: true });
cpSync(join(built, 'app'), join(preview, 'app'), { recursive: true });

console.log('stage-subpath: staged .preview-web/{site,app}');
