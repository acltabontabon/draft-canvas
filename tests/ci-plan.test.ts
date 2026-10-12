// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/ci-plan.mjs', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', stdio: 'pipe',
}).trim();

const lock = (version: string) => JSON.stringify({ packages: { 'node_modules/@playwright/test': { version } } });

describe('CI scope from the complete tested changeset', () => {
  let root: string;
  let repo: string;
  let before: string;
  let revision: string;

  const write = (path: string, content = 'changed') => {
    const dest = join(repo, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  };
  const commit = () => {
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Test changes');
    revision = git(repo, 'rev-parse', 'HEAD');
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'draft-canvas-ci-'));
    repo = join(root, 'repo');
    git(root, 'init', '--initial-branch=main', repo);
    git(repo, 'config', 'user.name', 'CI test');
    git(repo, 'config', 'user.email', 'ci@example.test');
    git(repo, 'remote', 'add', 'origin', repo);
    write('package-lock.json', lock('1.63.0'));
    write('docs/index.md', 'original');
    write('src/app.ts', 'original');
    commit();
    before = revision;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const plan = (eventName = 'pull_request', overrides: Record<string, unknown> = {}, force = false) => {
    const eventPath = join(root, 'event.json');
    const output = join(root, 'output');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: before } }, before, ref: 'refs/heads/main', ...overrides }));
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [script], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, SOURCE_REVISION: revision, GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, DEFAULT_BRANCH: 'main', FORCE_FULL: String(force) },
    });
    return { ...result, output: readFileSync(output, 'utf8') };
  };

  it.each(['docs/guides/new-guide.md', 'docs/media/new-shot.png', 'README.md', 'CONTRIBUTING.md',
    'AGENTS.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md'])('uses documentation checks for %s', (path) => {
    write(path);
    commit();
    const result = plan();
    expect(result.status).toBe(0);
    expect(result.output).toContain('full=false\n');
  });

  it.each(['src/app.ts', 'www/index.html', 'CHANGELOG.md', 'tests/new.test.ts', 'e2e/new.spec.ts',
    'scripts/new.mjs', '.github/workflows/ci.yml', 'public/icon.svg', 'docs/tool.mjs', 'unknown.txt'])
  ('requires all checks for %s, even with documentation changes', (path) => {
    write(path);
    write('docs/index.md');
    commit();
    expect(plan().output).toContain('full=true\n');
  });

  it('includes earlier commits in a pull request', () => {
    write('src/app.ts');
    commit();
    write('docs/index.md');
    commit();
    expect(plan().output).toContain('full=true\n');
  });

  it.each([['src/app.ts', 'docs/app.md'], ['docs/index.md', 'src/guide.md']])
  ('checks both paths when renaming %s to %s', (from, to) => {
    git(repo, 'mv', from, to);
    commit();
    expect(plan().output).toContain('full=true\n');
  });

  it('permits documentation deletions', () => {
    git(repo, 'rm', 'docs/index.md');
    commit();
    expect(plan().output).toContain('full=false\n');
  });

  it('uses the before revision for main pushes', () => {
    write('docs/index.md');
    commit();
    expect(plan('push').output).toContain('full=false\n');
  });

  it.each(['workflow_dispatch', 'schedule'])('runs full checks for %s', (eventName) => {
    write('docs/index.md');
    commit();
    expect(plan(eventName).output).toContain('full=true\n');
  });

  it('runs full checks for release tags and reusable callers', () => {
    write('docs/index.md');
    commit();
    expect(plan('push', { ref: 'refs/tags/v1.0.0' }).output).toContain('full=true\n');
    expect(plan('pull_request', {}, true).output).toContain('full=true\n');
  });

  it('falls back to full checks for missing history, metadata, or an empty diff', () => {
    expect(plan().output).toContain('full=true\n');
    write('docs/index.md');
    commit();
    expect(plan('push', { before: '0'.repeat(40) }).output).toContain('full=true\n');
    expect(plan('push', { before: 'a'.repeat(40) }).output).toContain('full=true\n');
    expect(plan('pull_request', { pull_request: null }).output).toContain('full=true\n');
  });

  it('selects the image from the tested source lockfile', () => {
    write('package-lock.json', lock('1.64.0'));
    commit();
    expect(plan().output).toContain('playwright-image=mcr.microsoft.com/playwright:v1.64.0-noble\n');
    revision = before;
    expect(plan().output).toContain('playwright-image=mcr.microsoft.com/playwright:v1.63.0-noble\n');
  });

  it('fails explicitly for an invalid image version', () => {
    write('package-lock.json', lock('latest'));
    commit();
    const result = plan();
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
    expect(result.stderr).toContain('Unsupported Playwright version');
  });
});

describe('the final CI verification gate', () => {
  // Execute the gate shipped in the workflow, so moving coverage cannot silently weaken it.
  const gate = workflow.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)![1]!;
  const results = (full: boolean, performance = false) => Object.fromEntries(['source', 'workflows', 'build', 'coverage',
    'docs', 'e2e', 'security', 'performance'].map((job) => [job, {
    result: (job === 'performance' ? performance
      : job === 'source' || job === 'workflows' || (full ? job !== 'docs' : job === 'docs')) ? 'success' : 'skipped',
  }]));
  const verify = (full: string, checks = results(full === 'true'), reused = 'false', performance = 'false') => spawnSync(process.execPath, ['-e', gate], {
    encoding: 'utf8', env: { ...process.env, FULL: full, REUSED: reused, PERFORMANCE: performance, RESULTS: JSON.stringify(checks) },
  }).status;

  it('accepts full verification and intentional documentation skips', () => {
    expect(verify('true')).toBe(0);
    expect(verify('false')).toBe(0);
  });

  it.each(['build', 'coverage', 'e2e', 'security', 'workflows'])
  ('rejects a failure, cancellation or unexpected skip in %s', (job) => {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const checks = results(true);
      checks[job] = { result };
      expect(verify('true', checks)).not.toBe(0);
    }
  });

  it('requires successful performance checks for tagged releases and permits ordinary CI skips', () => {
    expect(verify('true', results(true, true), 'false', 'true')).toBe(0);
    expect(verify('true', results(true))).toBe(0);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const checks = results(true, true);
      checks.performance = { result };
      expect(verify('true', checks, 'false', 'true')).not.toBe(0);
    }
    expect(verify('true', results(true, true), 'true', 'true')).not.toBe(0);
    expect(verify('false', results(false, true), 'false', 'true')).not.toBe(0);
    expect(verify('true', results(true), 'false', '')).not.toBe(0);
  });

  it('accepts reuse only with fresh workflow validation and applicable security checks', () => {
    for (const full of ['true', 'false']) {
      const checks = results(full === 'true');
      for (const job of ['build', 'coverage', 'docs', 'e2e', 'performance']) checks[job] = { result: 'skipped' };
      expect(verify(full, checks, 'true')).toBe(0);
      checks.workflows = { result: 'skipped' };
      expect(verify(full, checks, 'true')).not.toBe(0);
    }
    const checks = results(true);
    for (const job of ['build', 'coverage', 'e2e', 'performance']) checks[job] = { result: 'skipped' };
    checks.security = { result: 'skipped' };
    expect(verify('true', checks, 'true')).not.toBe(0);
    expect(verify('true', results(true), '')).not.toBe(0);
    expect(verify('true', results(true), 'true')).not.toBe(0);
  });

  it('requires the lightweight docs check and a known scope', () => {
    const checks = results(false);
    checks.docs = { result: 'failure' };
    expect(verify('false', checks)).not.toBe(0);
    expect(verify('')).not.toBe(0);
  });
});
