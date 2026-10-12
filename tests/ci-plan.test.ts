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
    expect(result.output).toContain('desktop=false\n');
  });

  it.each(['src/app.ts', 'www/index.html', 'CHANGELOG.md', 'tests/new.test.ts', 'e2e/new.spec.ts',
    'scripts/new.mjs', '.github/workflows/ci.yml', 'public/icon.svg', 'docs/tool.mjs', 'unknown.txt'])
  ('requires all checks for %s, even with documentation changes', (path) => {
    write(path);
    write('docs/index.md');
    commit();
    expect(plan().output).toContain('full=true\n');
  });

  it.each(['src/app.ts', 'src-tauri/Cargo.toml', 'tests/desktop/boot.test.ts',
    'e2e/desktop/home.spec.ts', 'scripts/check-desktop-version.mjs', 'scripts/build-sidecar.mjs',
    'scripts/desktop-bindings.mjs', 'scripts/ci-plan.mjs', 'scripts/ci-reuse.mjs', 'scripts/verify-source.mjs',
    'tests/ci-plan.test.ts', 'tests/ci-reuse.test.ts', '.github/workflows/ci.yml', '.github/workflows/shared-checks.yml',
    '.github/workflows/desktop-ci.yml', 'playwright.desktop.config.ts', 'vite.config.ts',
    'tsconfig.test.json', 'package.json', 'tray.html', 'index.html'])
  ('requires native and desktop browser checks for %s', (path) => {
    write(path);
    commit();
    expect(plan().output).toContain('desktop=true\n');
  });

  it.each(['www/index.html', 'tests/document.test.ts', 'e2e/editing.spec.ts', 'CHANGELOG.md'])
  ('keeps web/shared checks without native runners for %s', (path) => {
    write(path);
    commit();
    const output = plan().output;
    expect(output).toContain('full=true\n');
    expect(output).toContain('desktop=false\n');
  });

  it('includes desktop changes from earlier commits and both sides of a rename', () => {
    write('src/app.ts');
    commit();
    write('docs/index.md');
    commit();
    expect(plan().output).toContain('desktop=true\n');
    git(repo, 'mv', 'src/app.ts', 'docs/app.md');
    commit();
    expect(plan().output).toContain('desktop=true\n');
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
    expect(plan('push', { ref: 'refs/tags/v1.0.0' }).output).toContain('desktop=true\n');
    expect(plan('pull_request', {}, true).output).toContain('desktop=true\n');
    expect(plan('pull_request', {}, true).output).toContain('full=true\n');
  });

  it('falls back to full checks for missing history, metadata, or an empty diff', () => {
    expect(plan().output).toContain('full=true\n');
    expect(plan().output).toContain('desktop=true\n');
    write('docs/index.md');
    commit();
    expect(plan('push', { before: '0'.repeat(40) }).output).toContain('full=true\n');
    expect(plan('push', { before: 'a'.repeat(40) }).output).toContain('full=true\n');
    expect(plan('pull_request', { pull_request: null }).output).toContain('full=true\n');
    expect(plan('push', { before: 'a'.repeat(40) }).output).toContain('desktop=true\n');
    expect(plan('pull_request', { pull_request: null }).output).toContain('desktop=true\n');
  });

  it('classifies changes without reading a browser version from the lockfile', () => {
    rmSync(join(repo, 'package-lock.json'));
    commit();
    const result = plan();
    expect(result.status).toBe(0);
    expect(result.output).toBe('full=true\ndesktop=true\n');
  });
});

describe('the final CI verification gate', () => {
  // Execute the gate shipped in the workflow, so moving coverage cannot silently weaken it.
  const gate = workflow.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)![1]!;
  const results = (full: boolean, desktop = full, performance = false) => Object.fromEntries(['source', 'workflows', 'build', 'shared',
    'docs', 'e2e', 'desktop', 'security', 'performance'].map((job) => [job, {
    result: (job === 'performance' ? performance : job === 'desktop' ? desktop
      : job === 'source' || job === 'workflows' || (full ? job !== 'docs' : job === 'docs')) ? 'success' : 'skipped',
  }]));
  const verify = (full: string, checks = results(full === 'true'), desktop = full, reused = 'false', performance = 'false') => spawnSync(process.execPath, ['-e', gate], {
    encoding: 'utf8', env: { ...process.env, FULL: full, DESKTOP: desktop, REUSED: reused, PERFORMANCE: performance, RESULTS: JSON.stringify(checks) },
  }).status;

  it('accepts full verification and intentional documentation skips', () => {
    expect(verify('true')).toBe(0);
    expect(verify('false')).toBe(0);
  });

  it.each(['build', 'shared', 'e2e', 'desktop', 'security', 'workflows'])
  ('rejects a failure, cancellation or unexpected skip in %s', (job) => {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const checks = results(true);
      checks[job] = { result };
      expect(verify('true', checks)).not.toBe(0);
    }
  });

  it('accepts intentional desktop skips for web-only changes and rejects unknown scopes', () => {
    expect(verify('true', results(true, false), 'false')).toBe(0);
    expect(verify('true', results(true, false), 'true')).not.toBe(0);
    expect(verify('true', results(true), 'false')).not.toBe(0);
    expect(verify('true', results(true), '')).not.toBe(0);
    expect(verify('false', results(false), 'true')).not.toBe(0);
  });

  it('requires successful performance checks for tagged releases and permits ordinary CI skips', () => {
    expect(verify('true', results(true, true, true), 'true', 'false', 'true')).toBe(0);
    expect(verify('true', results(true))).toBe(0);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const checks = results(true, true, true);
      checks.performance = { result };
      expect(verify('true', checks, 'true', 'false', 'true')).not.toBe(0);
    }
    expect(verify('true', results(true, true, true), 'true', 'true', 'true')).not.toBe(0);
    expect(verify('false', results(false, false, true), 'true', 'false', 'true')).not.toBe(0);
    expect(verify('true', results(true), 'true', 'false', '')).not.toBe(0);
    expect(verify('true', results(true, false, true), 'false', 'false', 'true')).not.toBe(0);
  });

  it('accepts reuse only with fresh workflow validation and applicable security checks', () => {
    for (const full of ['true', 'false']) {
      const checks = results(full === 'true');
      for (const job of ['build', 'shared', 'docs', 'e2e', 'desktop', 'performance']) checks[job] = { result: 'skipped' };
      expect(verify(full, checks, full, 'true')).toBe(0);
      checks.workflows = { result: 'skipped' };
      expect(verify(full, checks, full, 'true')).not.toBe(0);
    }
    const checks = results(true);
    for (const job of ['build', 'shared', 'e2e', 'desktop', 'performance']) checks[job] = { result: 'skipped' };
    checks.security = { result: 'skipped' };
    expect(verify('true', checks, 'true', 'true')).not.toBe(0);
    expect(verify('true', results(true), 'true', '')).not.toBe(0);
    expect(verify('true', results(true), 'true', 'true')).not.toBe(0);
  });

  it('requires the lightweight docs check and a known scope', () => {
    const checks = results(false);
    checks.docs = { result: 'failure' };
    expect(verify('false', checks)).not.toBe(0);
    expect(verify('')).not.toBe(0);
  });
});

describe('standalone desktop release verification', () => {
  const desktop = readFileSync(new URL('../.github/workflows/desktop-ci.yml', import.meta.url), 'utf8');
  const release = readFileSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('../.github/workflows/shared-checks.yml', import.meta.url), 'utf8');
  const gate = (source: string) => source.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)![1]!;
  const run = (source: string, env: Record<string, string>) => spawnSync(process.execPath, ['-e', gate(source)], {
    encoding: 'utf8', env: { ...process.env, ...env },
  }).status;

  it('has one PR/main entry point and one definition of common checks', () => {
    expect(desktop).not.toMatch(/^  (push|pull_request|workflow_dispatch):/m);
    expect(shared).toContain('npm run lint');
    expect(shared).toContain('npm run typecheck:tooling');
    expect(shared).toContain('npm run test:coverage');
    for (const source of [workflow, desktop]) {
      expect(source).not.toMatch(/run: npm (test|run (lint|typecheck:tooling|test:coverage))/);
      expect(source).toContain('uses: ./.github/workflows/shared-checks.yml');
    }
    expect(workflow).toContain('      shared-checks: false');
    expect(workflow).toContain("  security:\n    needs: source\n    if: needs.source.outputs.full == 'true'\n");
    expect(workflow.match(/CI_DESKTOP: \$\{\{ steps.plan.outputs.desktop \}\}/g)).toHaveLength(2);
    expect(workflow).toContain("    if: needs.source.outputs.desktop == 'true' && needs.source.outputs.reused != 'true'");
    expect(desktop).toMatch(/shared-checks:[\s\S]*?default: true/);
    expect(desktop).toContain("      - if: inputs.web-artifact-name == ''\n        run: npm run build");
  });

  it('validates the shared helper source before restoring caches or running selected code', () => {
    const refs = [...shared.matchAll(/          ref: (.+)/g)].map((match) => match[1]);
    expect(refs).toEqual(['${{ github.sha }}', '${{ steps.source.outputs.revision }}']);
    expect(shared).toContain('          SOURCE_REF: ${{ inputs.ref }}');
    expect(shared).toContain('          WORKFLOW_REVISION: ${{ github.sha }}');
    expect(shared).toContain('          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}');
    const validate = shared.indexOf('node scripts/verify-source.mjs');
    const selected = shared.indexOf('ref: ${{ steps.source.outputs.revision }}');
    expect(validate).toBeGreaterThan(0);
    expect(selected).toBeGreaterThan(validate);
    expect(shared.indexOf('uses: actions/setup-node@')).toBeGreaterThan(selected);
    expect(shared.indexOf('run: npm ci')).toBeGreaterThan(selected);
  });

  it.each(['true', 'false'])('requires all desktop jobs with shared scope %s', (scope) => {
    const checks = { source: { result: 'success' }, shared: { result: scope === 'true' ? 'success' : 'skipped' },
      frontend: { result: 'success' }, rust: { result: 'success' } };
    const verify = () => run(desktop, { SHARED: scope, RESULTS: JSON.stringify(checks) });
    expect(verify()).toBe(0);
    for (const job of ['source', 'frontend', 'rust'] as const) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        checks[job].result = result;
        expect(verify()).not.toBe(0);
      }
      checks[job].result = 'success';
    }
    checks.shared.result = scope === 'true' ? 'skipped' : 'success';
    expect(verify()).not.toBe(0);
    expect(run(desktop, { SHARED: '', RESULTS: JSON.stringify(checks) })).not.toBe(0);
  });

  it('requires timing acceptance for previews and standalone rebuilds', () => {
    const verify = (result: string) => run(release, {
      VERIFIED_COMMIT: '', SOURCE_COMMIT: 'a'.repeat(40), CHECKS_RESULT: 'success', VERIFY_RESULT: 'success',
      PERFORMANCE_RESULT: result, PREVIEW: 'true',
    });
    expect(verify('success')).toBe(0);
    for (const result of ['failure', 'cancelled', 'skipped']) expect(verify(result)).not.toBe(0);
    expect(release).toContain('needs: [verify, checks, performance]');
    const performance = readFileSync(new URL('../.github/workflows/performance.yml', import.meta.url), 'utf8');
    expect(performance).not.toContain('schedule:');
    expect(performance).toContain('workflow_dispatch:');
  });

  it('requires fresh checks for standalone previews/rebuilds and avoids repeating orchestrated CI', () => {
    const verify = (commit: string, checks: string, source = 'success', revision = commit) => run(release, {
      VERIFIED_COMMIT: commit, SOURCE_COMMIT: revision, CHECKS_RESULT: checks, VERIFY_RESULT: source,
      PERFORMANCE_RESULT: commit ? 'skipped' : 'success', PREVIEW: 'false',
    });
    expect(verify('', 'success')).toBe(0);
    expect(verify('a'.repeat(40), 'skipped')).toBe(0);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(verify('', result)).not.toBe(0);
      expect(verify('', 'success', result)).not.toBe(0);
      expect(verify('a'.repeat(40), 'skipped', result)).not.toBe(0);
    }
    expect(verify('a'.repeat(40), 'failure')).not.toBe(0);
    expect(verify('a'.repeat(40), 'skipped', 'success', 'b'.repeat(40))).not.toBe(0);
    expect(verify('main', 'skipped')).not.toBe(0);
    expect(release).toMatch(/  checks:\n[\s\S]*?if: inputs.verified-commit == ''/);
    expect(release).toContain('uses: ./.github/workflows/desktop-ci.yml');
  });
});
