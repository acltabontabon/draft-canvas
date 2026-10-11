#!/usr/bin/env node
// Retry against the current tap head instead of rebasing a generated file over another app's
// release. Only this app's cask is staged, and the version guard is rerun after every fetch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldUpdateCask, stableVersion } from './homebrew-cask.mjs';

export function updateTap(tag, candidate, directory) {
  const version = stableVersion(tag);
  const content = readFileSync(candidate, 'utf8');
  if (!content.includes(`  version "${version}"\n`)) throw new Error('Candidate cask version differs from release tag');
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (let attempt = 0; attempt < 5; attempt++) {
    git('fetch', 'origin', 'main');
    git('reset', '--hard', 'origin/main');
    const path = join(directory, 'Casks', 'draft-canvas.rb');
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (!shouldUpdateCask(current, tag)) return 'newer';
    if (current === content) return 'unchanged';
    mkdirSync(join(directory, 'Casks'), { recursive: true });
    writeFileSync(path, content);
    git('add', 'Casks/draft-canvas.rb');
    git('commit', '-m', `draft-canvas ${version}`);
    try {
      git('push', 'origin', 'HEAD:main');
      return 'updated';
    } catch (error) {
      if (attempt === 4) throw new Error(`Tap push failed after five attempts: ${error.stderr?.toString() ?? error.message}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [tag, candidate, directory] = process.argv.slice(2);
    if (!directory) throw new Error('Usage: update-homebrew-tap.mjs <vX.Y.Z> <candidate-cask> <tap-clone>');
    console.log(`Homebrew tap: ${updateTap(tag, candidate, directory)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
