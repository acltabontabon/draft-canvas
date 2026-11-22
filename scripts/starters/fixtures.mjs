#!/usr/bin/env node
/**
 * Copies a checkout of the starters gallery (github.com/acltabontabon/draft-canvas-starters) into
 * `tests/fixtures/starters/`: its catalog, every starter's file and metadata and every style pack,
 * nothing else. The
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
// Style packs sit beside the starters: each a `.draftstyle` file and what the catalog says about it.
let packs = 0;
const styles = join(repo, 'styles');
if (existsSync(styles)) {
  for (const id of readdirSync(styles)) {
    const dir = join(styles, id);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.draftstyle') && name !== 'pack.json') continue;
      const target = join(out, 'styles', id, name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(dir, name), target);
      if (name.endsWith('.draftstyle')) packs += 1;
    }
  }
}
console.log(`copied ${copied} starters and ${packs} style packs into ${relative(ROOT, out)}`);
