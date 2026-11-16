#!/usr/bin/env node
/**
 * Copies a checkout of the starters gallery (github.com/acltabontabon/draft-canvas-starters) into
 * `tests/fixtures/starters/`: its catalog and every starter's file and metadata, nothing else. The
 * tests and the e2e suite read this snapshot, so they never reach GitHub.
 *
 *   npm run starters:fixtures                      # from ../draft-canvas-starters
 *   npm run starters:fixtures -- --repo <checkout>
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const at = process.argv.indexOf('--repo');
const repo = resolve(at === -1 ? join(ROOT, '..', 'draft-canvas-starters') : process.argv[at + 1]);
const out = join(ROOT, 'tests', 'fixtures', 'starters');

if (!existsSync(join(repo, 'catalog.json'))) {
  console.error(`No starters gallery at ${repo} (catalog.json missing). Pass --repo <checkout>.`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(repo, 'catalog.json'), join(out, 'catalog.json'));
let copied = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.draftcanvas') || name === 'starter.json') {
      const target = join(out, relative(repo, path));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target);
      if (name.endsWith('.draftcanvas')) copied += 1;
    }
  }
};
walk(join(repo, 'starters'));
console.log(`copied ${copied} starters into ${relative(ROOT, out)}`);
