// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/verify-source.mjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
  cwd,
  encoding: 'utf8',
  stdio: 'pipe',
}).trim();

describe('source verification before executing release code', () => {
  let root: string;
  let remote: string;
  let checkout: string;
  let released: string;
  let reviewed: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'draft-canvas-source-'));
    remote = join(root, 'remote');
    git(root, 'init', '--initial-branch=trunk', remote);
    git(remote, 'config', 'user.name', 'Source verification test');
    git(remote, 'config', 'user.email', 'source@example.test');
    writeFileSync(join(remote, 'source.txt'), 'released');
    git(remote, 'add', 'source.txt');
    git(remote, 'commit', '-m', 'Released source');
    released = git(remote, 'rev-parse', 'HEAD');
    git(remote, 'tag', '-a', 'v1.0.0', '-m', 'Historical release');
    writeFileSync(join(remote, 'source.txt'), 'reviewed');
    git(remote, 'commit', '-am', 'Reviewed source');
    reviewed = git(remote, 'rev-parse', 'HEAD');
    git(remote, 'switch', '-c', 'unreviewed');
    writeFileSync(join(remote, 'source.txt'), 'unreviewed');
    git(remote, 'commit', '-am', 'Unreviewed source');
    git(remote, 'tag', 'v9.0.0');
    git(remote, 'switch', 'trunk');
  });

  beforeEach(() => {
    checkout = join(mkdtempSync(join(root, 'case-')), 'checkout');
    git(root, 'clone', '--depth=1', '--', pathToFileURL(remote).href, checkout);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const verify = (source: string, workflow = reviewed) => spawnSync(process.execPath, [script], {
    cwd: checkout,
    encoding: 'utf8',
    env: { ...process.env, SOURCE_REF: source, WORKFLOW_REVISION: workflow, DEFAULT_BRANCH: 'trunk' },
  });

  it('accepts the triggering revision without fetching history', () => {
    git(checkout, 'remote', 'remove', 'origin');
    const result = verify('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(reviewed);
  });

  it('allows republishing an annotated historical release from a shallow checkout', () => {
    expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const result = verify('refs/tags/v1.0.0');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(released);
  });

  it('rejects an unreviewed commit even when it has a release-shaped tag', () => {
    const result = verify('refs/tags/v9.0.0');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('outside the repository default branch history');
  });

  it('refuses to validate using a checkout other than the triggering revision', () => {
    const result = verify('', released);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('must start from the workflow revision');
  });

  it('rejects fetch options instead of treating them as a source ref', () => {
    const result = verify('--upload-pack=untrusted');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid source ref');
  });
});
