#!/usr/bin/env node
// About → What's New, exactly as a build would show it: the changelog's marked highlights for one
// platform (the same `whatsNew` vite.config.ts bundles). For checking highlights before a release.
//
//   node scripts/whats-new.mjs desktop|web                 every release's entry
//   node scripts/whats-new.mjs desktop|web --draft 1.10.0  …as if 1.10.0 had a (still empty) section

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangelogError, whatsNew, withDraft } from './changelog.mjs';

const [platform, ...rest] = process.argv.slice(2);
const draft = rest.includes('--draft') ? rest[rest.indexOf('--draft') + 1] : undefined;
try {
  if (platform !== 'desktop' && platform !== 'web') throw new ChangelogError('Usage: whats-new.mjs desktop|web [--draft X.Y.Z]');
  let changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
  if (draft) changelog = withDraft(changelog, draft);
  process.stdout.write(`${JSON.stringify(whatsNew(changelog, platform), null, 2)}\n`);
} catch (error) {
  console.error(`::error::${error instanceof ChangelogError ? error.message : error}`);
  process.exit(1);
}
