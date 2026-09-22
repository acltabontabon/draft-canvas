#!/usr/bin/env node
/*
 * The screenshots the page embeds, in the theme the product ships in.
 *
 *     npm run site:shots        (from the repository root)
 *
 * The guides in docs/ are generated in the light theme by e2e/docs-screenshots.ts, which drives the
 * real UI through the steps the guides describe. This runs that same harness in the dark palette
 * rather than adding a second one that would slowly disagree with it, then copies across only the
 * handful the page actually uses — so what is committed here is exactly what is deployed, and a
 * shot that stops being used stops shipping.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(www, '..');
const staging = join(www, '.shots');
const out = join(www, 'public', 'shots');

/** Each one is embedded by index.html, with alt text describing what it shows. */
const USED = ['suggestion', 'presenting', 'depth-map', 'export-document'];

rmSync(staging, { recursive: true, force: true });
execFileSync(
  'npx',
  ['tsx', 'e2e/docs-screenshots.ts', '--theme', 'dark', '--out', 'www/.shots'],
  { cwd: root, stdio: 'inherit' },
);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of USED) {
  const from = join(staging, `${name}.png`);
  if (!existsSync(from)) {
    console.error(`shots: the harness produced no ${name}.png — has the walkthrough changed?`);
    process.exit(1);
  }
  copyFileSync(from, join(out, `${name}.png`));
}
rmSync(staging, { recursive: true, force: true });

console.log(`shots: ${readdirSync(out).join(', ')}`);
