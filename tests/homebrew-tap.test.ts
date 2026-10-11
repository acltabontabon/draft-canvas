import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCask } from '../scripts/homebrew-cask.mjs';
import { updateTap } from '../scripts/update-homebrew-tap.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cask = (version: string, digest = 'a') => buildCask({ version, armSha256: digest.repeat(64), intelSha256: 'b'.repeat(64) });
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function tap() {
  const dir = mkdtempSync(join(tmpdir(), 'draft-canvas-tap-'));
  dirs.push(dir);
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  const local = join(dir, 'local');
  mkdirSync(remote);
  mkdirSync(seed);
  git(remote, 'init', '--bare', '-b', 'main');
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'test');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  mkdirSync(join(seed, 'Casks'));
  writeFileSync(join(seed, 'Casks', 'habi.rb'), 'habi release one\n');
  writeFileSync(join(seed, 'Casks', 'draft-canvas.rb'), cask('1.13.0'));
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main');
  git(dir, 'clone', remote, local);
  git(local, 'config', 'user.name', 'test');
  git(local, 'config', 'user.email', 'test@example.invalid');
  const candidate = join(dir, 'candidate.rb');
  writeFileSync(candidate, cask('1.13.1'));
  return { dir, remote, seed, local, candidate };
}

describe('the shared Homebrew tap writer', () => {
  it('changes only Draft Canvas, makes repeated publication a no-op, and accepts rebuilt checksums', () => {
    const { remote, local, candidate } = tap();
    expect(updateTap('v1.13.1', candidate, local)).toBe('updated');
    expect(git(remote, 'show', 'main:Casks/habi.rb')).toBe('habi release one');
    expect(git(remote, 'show', '--pretty=', '--name-only', 'main')).toBe('Casks/draft-canvas.rb');
    const head = git(remote, 'rev-parse', 'main');
    expect(updateTap('v1.13.1', candidate, local)).toBe('unchanged');
    expect(git(remote, 'rev-parse', 'main')).toBe(head);
    writeFileSync(candidate, cask('1.13.1', 'c'));
    expect(updateTap('v1.13.1', candidate, local)).toBe('updated');
    expect(git(remote, 'show', 'main:Casks/draft-canvas.rb')).toContain('c'.repeat(64));
  });

  it('retries a real rejected push while preserving a concurrent Habi release', () => {
    const { seed, remote, local, candidate } = tap();
    writeFileSync(join(seed, 'Casks', 'habi.rb'), 'habi release two\n');
    git(seed, 'add', 'Casks/habi.rb');
    git(seed, 'commit', '-m', 'habi update');
    const hook = join(local, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\nrm "$0"\ngit -C '${seed}' push origin main\n`);
    chmodSync(hook, 0o755);
    expect(updateTap('v1.13.1', candidate, local)).toBe('updated');
    expect(git(remote, 'show', 'main:Casks/habi.rb')).toBe('habi release two');
    expect(git(remote, 'show', 'main:Casks/draft-canvas.rb')).toContain('version "1.13.1"');
  });

  it('rechecks versions after a rejected push and preserves a concurrently published newer cask', () => {
    const { seed, remote, local, candidate } = tap();
    writeFileSync(join(seed, 'Casks', 'draft-canvas.rb'), cask('1.14.0'));
    git(seed, 'add', 'Casks/draft-canvas.rb');
    git(seed, 'commit', '-m', 'newer release');
    const hook = join(local, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\nrm "$0"\ngit -C '${seed}' push origin main\n`);
    chmodSync(hook, 0o755);
    expect(updateTap('v1.13.1', candidate, local)).toBe('newer');
    expect(git(remote, 'show', 'main:Casks/draft-canvas.rb')).toContain('version "1.14.0"');
  });

  it('fails visibly after repeated push failures without publishing anything', () => {
    const { remote, local, candidate } = tap();
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    expect(() => updateTap('v1.13.1', candidate, local)).toThrow('five attempts');
    expect(git(remote, 'show', 'main:Casks/draft-canvas.rb')).toContain('version "1.13.0"');
    expect(readFileSync(candidate, 'utf8')).toContain('version "1.13.1"');
  });
});
