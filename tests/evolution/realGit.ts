/**
 * Standard Git, run against what the history backends write. These tests are the interoperability
 * promise: `git fsck`, `git log`, `git show` and `git clone` must accept our repositories and
 * bundles, and our import must accept Git's.
 *
 * Under CI they are mandatory — a runner without Git fails them instead of skipping. Locally,
 * without Git, they are skipped with a notice.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
export const HAS_GIT = probe.status === 0;

if (!HAS_GIT && process.env.CI) {
  throw new Error('Git is required for the Canvas Evolution interoperability tests in CI.');
}
if (!HAS_GIT) console.warn('[evolution] git not found: interoperability tests are skipped locally.');

/** A scratch directory, removed by the returned function. */
export function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dc-evolution-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Runs git with no system or global configuration, no hooks and fixed identity, so the result
 * depends only on the repository.
 */
export function git(cwd: string, args: string[], input?: string | Uint8Array): { stdout: string; stdoutBytes: Buffer; status: number; stderr: string } {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    input,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@draftcanvas.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@draftcanvas.invalid',
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    },
    maxBuffer: 256 * 1024 * 1024,
  });
  return { stdout: result.stdout?.toString('utf8') ?? '', stdoutBytes: result.stdout ?? Buffer.alloc(0), status: result.status ?? -1, stderr: result.stderr?.toString('utf8') ?? '' };
}

export function gitOk(cwd: string, args: string[], input?: string | Uint8Array): string {
  const result = git(cwd, args, input);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}
