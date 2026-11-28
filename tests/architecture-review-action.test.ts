// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error -- a plain Node script, run by the action as it is
import { assetName, baseRevision, listedChecksum, releaseTag, run, sha256, SUMMARY_LIMIT } from '../scripts/architecture-review-action.mjs';

const ROOT = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'dc-action-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the architecture review action', () => {
  const action = parse(readFileSync(join(ROOT, 'action.yml'), 'utf8')) as { inputs: Record<string, unknown>; runs: { using: string; steps: { run?: string; uses?: string; env?: Record<string, string> }[] } };

  it('never pastes an input or an event value into a command line', () => {
    expect(action.runs.using).toBe('composite');
    for (const step of action.runs.steps) {
      // `${{ }}` in a script is replaced before the shell reads it: a branch named `$(…)` would run.
      expect(step.run ?? '').not.toMatch(/\$\{\{/);
      expect(step.uses).toBeUndefined();
    }
    expect(Object.keys(action.runs.steps[0]!.env ?? {}).sort()).toEqual(['DC_ACTION_REF', 'DC_BASE', 'DC_BASE_SHA', 'DC_CLI', 'DC_FAIL_ON', 'DC_REPO', 'DC_VERSION', 'GH_TOKEN']);
  });

  it('runs no shell and reaches only the release it names', () => {
    const script = readFileSync(join(ROOT, 'scripts/architecture-review-action.mjs'), 'utf8');
    // Only the two calls that take a program and its arguments apart; never one that parses a command line.
    expect(script).toContain("import { execFileSync, spawnSync } from 'node:child_process';");
    expect(script).not.toMatch(/shell:\s*true/);
    expect(script).not.toMatch(/\bfetch\(|https?:\/\//);
    expect(script.match(/execFileSync\('gh'/g)).toHaveLength(2);
  });

  it('takes the release from the input, else from the tag the action was referenced by', () => {
    expect(releaseTag('v2.0.0', 'main')).toBe('v2.0.0');
    expect(releaseTag('', 'v2.1.3')).toBe('v2.1.3');
    expect(releaseTag(' v2.0.0-beta.1 ', '')).toBe('v2.0.0-beta.1');
    expect(() => releaseTag('', 'main')).toThrow(/Name the Draft Canvas release/);
    expect(() => releaseTag('', '0123abc')).toThrow();
    for (const bad of ['2.0.0', 'latest', 'v2', 'v2.0.0; rm -rf /', '--repo=evil/x', 'v2.0.0/../x']) expect(() => releaseTag(bad, 'v2.0.0'), bad).toThrow(/must be a release tag/);
    expect(assetName('v2.0.0')).toBe('Draft-Canvas_2.0.0_cli.mjs');
    expect(assetName('v2.0.0-beta.1')).toBe('Draft-Canvas_2.0.0-beta.1_cli.mjs');
  });

  it('reads a checksum list as sha256sum writes it, and only for the exact name', () => {
    const sums = [`${'a'.repeat(64)}  ./Draft-Canvas_2.0.0_macOS_arm64.dmg`, `${'b'.repeat(64)}  ./Draft-Canvas_2.0.0_cli.mjs`, `${'c'.repeat(64)} *Draft-Canvas_2.0.0_Windows_x64.exe`, 'not a line'].join('\n');
    expect(listedChecksum(sums, 'Draft-Canvas_2.0.0_cli.mjs')).toBe('b'.repeat(64));
    expect(listedChecksum(sums, 'Draft-Canvas_2.0.0_Windows_x64.exe')).toBe('c'.repeat(64));
    expect(listedChecksum(sums, 'Draft-Canvas_2.0.0_cli.mj')).toBeNull();
    expect(listedChecksum(sums, 'cli.mjs')).toBeNull();
    const file = join(dir, 'x.txt');
    writeFileSync(file, 'abc');
    expect(sha256(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares with the base named, else the pull request\'s', () => {
    expect(baseRevision('origin/main', 'abc')).toBe('origin/main');
    expect(baseRevision('', 'abc123')).toBe('abc123');
    expect(() => baseRevision('', '')).toThrow(/pull_request/);
  });

  it('runs the CLI it is given, writes the report to the job summary and passes its exit code on', () => {
    // A stand-in CLI: records its arguments, writes the report it was asked for, exits as told.
    const cli = join(dir, 'cli.mjs');
    writeFileSync(cli, "import { writeFileSync } from 'node:fs';\nconst a = process.argv.slice(2);\nwriteFileSync(a[a.indexOf('--output') + 1], '## Architecture review\\n\\n' + JSON.stringify(a.filter((x) => !x.includes('architecture-review.md'))) + '\\n');\nprocess.exit(Number(process.env.STUB_EXIT ?? 0));\n");
    chmodSync(cli, 0o644);
    const temp = join(dir, 'runner');
    mkdirSync(temp);
    const env = { RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, 'summary.md'), GITHUB_OUTPUT: join(temp, 'output.txt'), DC_CLI: cli, DC_BASE: '', DC_BASE_SHA: 'abc123', DC_REPO: '', DC_FAIL_ON: 'warning', DC_VERSION: '', DC_ACTION_REF: 'main' };

    expect(run({ ...env, STUB_EXIT: '0' })).toBe(0);
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    expect(summary).toContain('## Architecture review');
    expect(summary).toContain('["review","--repo",".","--base","abc123","--fail-on","warning","--output"]');
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`report=${join(temp, 'architecture-review.md')}\n`);

    // A value that would be dangerous in a shell is passed through as one plain argument.
    process.env.STUB_EXIT = '1';
    try {
      expect(run({ ...env, DC_BASE: '$(touch pwned); main' })).toBe(1);
    } finally {
      delete process.env.STUB_EXIT;
    }
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('"--base","$(touch pwned); main"');
    expect(() => run({ ...env, DC_CLI: join(dir, 'missing.mjs') })).toThrow(/not a file/);
    expect(() => run({ ...env, DC_BASE_SHA: '' })).toThrow(/pull_request/);
    expect(SUMMARY_LIMIT).toBeLessThan(1024 * 1024);
  });
});
