import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The agent skill's scripts (`skills/draft-canvas/scripts/`) are Python, run by agents on repositories
 * nobody here has seen; their tests (`tests/skill/`) build small repositories and run them. Run here
 * so `npm test` covers them wherever Python 3.9+ is installed — CI's runners have it.
 */

const ROOT = join(__dirname, '..');

function python(): string | undefined {
  for (const command of ['python3', 'python']) {
    const found = spawnSync(command, ['-c', 'import sys; print(sys.version_info >= (3, 9))'], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim() === 'True') return command;
  }
  return undefined;
}

const interpreter = python();

describe('the agent skill scripts', () => {
  it.skipIf(!interpreter)('pass their own tests', () => {
    const run = spawnSync(interpreter!, ['-m', 'unittest', 'discover', '-s', 'tests/skill', '-p', 'test_*.py'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 150_000);
});
