// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findReusableRun } from '../scripts/ci-reuse.mjs';

const repository = 'owner/canvas';
const revision = '1'.repeat(40);
const head = '2'.repeat(40);
const base = '3'.repeat(40);
const testedRevision = '4'.repeat(40);
const tree = '5'.repeat(40);
const event = { repository: { default_branch: 'main' } };
const script = fileURLToPath(new URL('../scripts/ci-reuse.mjs', import.meta.url));

describe('reuse of successful PR verification', () => {
  const fixture = (workflow = 'ci.yml') => {
    const pull = { number: 42, merged: true, merge_commit_sha: revision,
      base: { ref: 'main', repo: { full_name: repository } }, head: { sha: head, repo: { full_name: repository } } };
    const run = { id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request',
      path: `.github/workflows/${workflow}`, repository: { full_name: repository }, head_sha: head };
    const proof = { version: 1, repository, workflow, runId: 100, attempt: 1, pull: 42,
      head, base, revision: testedRevision, tree, full: true };
    const tested = { sha: testedRevision, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] };
    const evidence = vi.fn(() => proof);
    const api = vi.fn((path: string) => {
      if (path.includes('/commits/') && path.includes('/pulls?')) return [{ number: 42 }];
      if (path.endsWith('/pulls/42')) return pull;
      if (path.includes('/actions/workflows/')) return { workflow_runs: [run] };
      if (path.endsWith(`/git/commits/${testedRevision}`)) return tested;
      throw new Error(`Unexpected API call: ${path}`);
    });
    const lookup = (full = true) => findReusableRun({ repository, revision, tree, full, workflow, event, api, evidence });
    return { pull, run, proof, tested, evidence, api, lookup };
  };

  it.each(['ci.yml', 'desktop-ci.yml'])('reuses %s when the tested merge tree matches a different landed SHA', (workflow) => {
    const f = fixture(workflow);
    expect(f.lookup()).toEqual({ id: 100, url: `https://github.com/${repository}/actions/runs/100` });
    expect(f.evidence).toHaveBeenCalledWith(f.run, `ci-evidence-${workflow}-100-1`);
  });

  it('requires an exact match for the entire tree, even when the PR head is unchanged', () => {
    const f = fixture();
    f.proof.tree = '6'.repeat(40);
    expect(f.lookup()).toBeNull();
    expect(f.api).not.toHaveBeenCalledWith(`repos/${repository}/git/commits/${testedRevision}`);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'neutral'])('rejects a %s run', (conclusion) => {
    const f = fixture();
    f.run.conclusion = conclusion;
    expect(f.lookup()).toBeNull();
    expect(f.evidence).not.toHaveBeenCalled();
  });

  it('rejects an unfinished run and a failed latest rerun', () => {
    const f = fixture();
    f.run.status = 'in_progress';
    expect(f.lookup()).toBeNull();
    f.run.status = 'completed';
    f.run.run_attempt = 2;
    f.run.conclusion = 'failure';
    expect(f.lookup()).toBeNull();
  });

  it('does not use evidence from an earlier attempt after a rerun', () => {
    const f = fixture();
    f.run.run_attempt = 2;
    expect(f.lookup()).toBeNull();
    expect(f.evidence).toHaveBeenCalledWith(f.run, 'ci-evidence-ci.yml-100-2');
  });

  it('requires a merged PR at this exact main revision', () => {
    const f = fixture();
    f.pull.merged = false;
    expect(f.lookup()).toBeNull();
    f.pull.merged = true;
    f.pull.merge_commit_sha = '6'.repeat(40);
    expect(f.lookup()).toBeNull();
    f.pull.merge_commit_sha = revision;
    f.pull.base.ref = 'other';
    expect(f.lookup()).toBeNull();
  });

  it('does not reuse checks from forks, a different workflow, event, repository or head', () => {
    const f = fixture();
    f.pull.head.repo.full_name = 'fork/canvas';
    expect(f.lookup()).toBeNull();
    f.pull.head.repo.full_name = repository;
    for (const change of [{ path: '.github/workflows/other.yml' }, { event: 'push' }, { head_sha: base },
      { repository: { full_name: 'other/canvas' } }]) {
      const original = { ...f.run };
      Object.assign(f.run, change);
      expect(f.lookup()).toBeNull();
      Object.assign(f.run, original);
    }
  });

  it('requires evidence bound to the same run, attempt, PR, head and workflow', () => {
    const f = fixture();
    for (const change of [{ version: 2 }, { repository: 'other/canvas' }, { workflow: 'desktop-ci.yml' },
      { runId: 101 }, { attempt: 2 }, { pull: 43 }, { head: base }, { revision: '--untrusted' }, { base: '' }]) {
      const original = { ...f.proof };
      Object.assign(f.proof, change);
      expect(f.lookup()).toBeNull();
      Object.assign(f.proof, original);
    }
  });

  it('cannot substitute docs-only checks for full verification', () => {
    const f = fixture();
    f.proof.full = false;
    expect(f.lookup()).toBeNull();
    expect(f.lookup(false)).not.toBeNull();
    f.proof.full = true;
    expect(f.lookup(false)).not.toBeNull();
  });

  it('resolves the recorded commit independently instead of trusting its claimed tree', () => {
    const f = fixture();
    f.tested.tree.sha = '6'.repeat(40);
    expect(f.lookup()).toBeNull();
    f.tested.tree.sha = tree;
    f.tested.sha = head;
    expect(f.lookup()).toBeNull();
    f.tested.sha = testedRevision;
    f.tested.parents = [{ sha: head }];
    expect(f.lookup()).toBeNull();
    f.tested.parents = [{ sha: base }, { sha: '6'.repeat(40) }];
    expect(f.lookup()).toBeNull();
  });

  it('falls back for absent or expired evidence and unavailable merge commits', () => {
    const f = fixture();
    f.evidence.mockImplementation(() => { throw new Error('Artifact expired'); });
    expect(f.lookup()).toBeNull();
    f.evidence.mockImplementation(() => f.proof);
    f.api.mockImplementation((path) => {
      if (path.includes('/git/commits/')) throw new Error('Commit unavailable');
      if (path.includes('/actions/workflows/')) return { workflow_runs: [f.run] };
      if (path.endsWith('/pulls/42')) return f.pull;
      return [{ number: 42 }];
    });
    expect(f.lookup()).toBeNull();
  });

  it('does not reuse a direct push with no merged PR', () => {
    const f = fixture();
    f.api.mockReturnValue([]);
    expect(f.lookup()).toBeNull();
    expect(f.evidence).not.toHaveBeenCalled();
  });
});

describe('CI evidence CLI defaults to fresh checks', () => {
  let root: string;
  let repo: string;
  let commit: string;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'draft-canvas-reuse-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.test');
    writeFileSync(join(repo, 'app.txt'), 'source');
    git('add', '.');
    git('commit', '-m', 'Source');
    commit = git('rev-parse', 'HEAD');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cli = (mode = 'lookup', eventName = 'push', overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
    const output = join(root, 'output');
    const eventPath = join(root, 'event.json');
    writeFileSync(output, '');
    writeFileSync(eventPath, JSON.stringify({ ...event, ref: 'refs/heads/main', before: base, after: commit,
      pull_request: { number: 42, head: { sha: head }, base: { sha: base } }, ...overrides }));
    const result = spawnSync(process.execPath, [script, mode, 'ci.yml'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(root, 'summary'), GITHUB_REPOSITORY: repository, SOURCE_REVISION: commit,
        CI_FULL: 'true', FORCE_FULL: 'false', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', ...env },
    });
    return { ...result, output: readFileSync(output, 'utf8') };
  };

  it.each(['pull_request', 'workflow_dispatch', 'schedule'])('disables reuse for %s', (eventName) => {
    const result = cli('lookup', eventName);
    expect(result.status).toBe(0);
    expect(result.output).toBe('reused=false\n');
  });

  it.each([{ forced: true }, { created: true }, { deleted: true }, { ref: 'refs/tags/v1.0.0' },
    { before: '0'.repeat(40) }, { after: head }])('disables reuse for nonstandard pushes: %j', (overrides) => {
    expect(cli('lookup', 'push', overrides).output).toBe('reused=false\n');
  });

  it('keeps reusable release verification fresh even for a main push event', () => {
    expect(cli('lookup', 'push', {}, { FORCE_FULL: 'true' }).output).toBe('reused=false\n');
  });

  it('falls back when API access or event metadata is unavailable', () => {
    // Use an unavailable gh executable: this test cannot call the real GitHub API.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    execFileSync('ln', ['-s', process.execPath, join(bin, 'node')]);
    execFileSync('ln', ['-s', execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git')]);
    const result = cli('lookup', 'push', {}, { PATH: bin });
    expect(result.status).toBe(0);
    expect(result.output).toBe('reused=false\n');
    expect(result.stderr).toContain('Could not reuse PR verification');
    expect(cli('lookup', 'push', { repository: null }).output).toBe('reused=false\n');
  });

  const prepareMerge = () => {
    const original = commit;
    writeFileSync(join(repo, 'app.txt'), 'PR source');
    git('commit', '-am', 'PR head');
    const prHead = git('rev-parse', 'HEAD');
    const prTree = git('rev-parse', 'HEAD^{tree}');
    const tested = git('commit-tree', prTree, '-p', original, '-p', prHead, '-m', 'Temporary PR merge');
    git('checkout', '--detach', tested);
    commit = tested;
    return { original, prHead, prTree, tested,
      pullRequest: { number: 42, head: { sha: prHead }, base: { sha: original } } };
  };

  it('records the checked out merge tree and actual base even when event base metadata lags', () => {
    const { original, prHead, pullRequest } = prepareMerge();
    pullRequest.base.sha = base;
    writeFileSync(join(repo, '.git', 'shallow'), `${commit}\n`);
    expect(git('show', '-s', '--format=%P', 'HEAD')).toBe('');
    expect(cli('record', 'pull_request', { pull_request: pullRequest }).status).toBe(0);
    const proof = JSON.parse(readFileSync(join(repo, 'ci-evidence.json'), 'utf8'));
    expect(proof).toMatchObject({ version: 1, repository, workflow: 'ci.yml', runId: 100, attempt: 1,
      pull: 42, head: prHead, base: original, revision: commit, tree: git('rev-parse', 'HEAD^{tree}'), full: true });
  });

  it('refuses to record evidence for a checkout other than the tested revision', () => {
    expect(cli('record', 'pull_request', {}, { SOURCE_REVISION: head }).status).not.toBe(0);
    expect(cli('record', 'push').status).not.toBe(0);
    expect(cli('record', 'pull_request').status).not.toBe(0);
  });

  it('reuses real merge-tree evidence through the CLI without downloading or running PR build code', () => {
    const { original, prHead, prTree, tested, pullRequest } = prepareMerge();
    expect(cli('record', 'pull_request', { pull_request: pullRequest }).status).toBe(0);
    const proof = JSON.parse(readFileSync(join(repo, 'ci-evidence.json'), 'utf8'));
    commit = git('commit-tree', prTree, '-p', original, '-p', prHead, '-m', 'Landed merge');
    expect(commit).not.toBe(tested);
    git('checkout', '--detach', commit);

    const fixturePath = join(root, 'github.json');
    const fixture = {
      revision: commit, proof, tree: prTree, tested, base: original, head: prHead,
    };
    writeFileSync(fixturePath, JSON.stringify(fixture));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const f = JSON.parse(fs.readFileSync(process.env.TEST_GITHUB_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'run' && args[1] === 'download') {
  if (args[2] !== '100' || args[args.indexOf('--name') + 1] !== 'ci-evidence-ci.yml-100-1') process.exit(1);
  fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'ci-evidence.json'), JSON.stringify(f.proof));
} else if (args[0] === 'api') {
  const route = args[1];
  let value;
  if (route.endsWith('/commits/' + f.revision + '/pulls?per_page=10')) value = [{ number: 42 }];
  else if (route.endsWith('/pulls/42')) value = { number: 42, merged: true, merge_commit_sha: f.revision,
    base: { ref: 'main', repo: { full_name: '${repository}' } }, head: { sha: f.head, repo: { full_name: '${repository}' } } };
  else if (route.includes('/actions/workflows/')) value = { workflow_runs: [{ id: 100, run_attempt: 1,
    status: 'completed', conclusion: 'success', event: 'pull_request', path: '.github/workflows/ci.yml',
    repository: { full_name: '${repository}' }, head_sha: f.head }] };
  else if (route.endsWith('/runs/100/artifacts?per_page=100')) value = { artifacts: [{
    name: 'ci-evidence-ci.yml-100-1', expired: false, size_in_bytes: 500 }] };
  else if (route.endsWith('/git/commits/' + f.tested)) value = { sha: f.tested, tree: { sha: f.tree },
    parents: [{ sha: f.base }, { sha: f.head }] };
  else process.exit(1);
  process.stdout.write(JSON.stringify(value));
} else process.exit(1);
`, { mode: 0o755 });
    const env = { TEST_GITHUB_FIXTURE: fixturePath, PATH: `${bin}:${process.env.PATH}` };
    const result = cli('lookup', 'push', {}, env);
    expect(result.status).toBe(0);
    expect(result.output).toBe('reused=true\n');
    expect(readFileSync(join(root, 'summary'), 'utf8')).toContain(`/actions/runs/100`);

    // Squash merges have one parent and a new SHA, but can contain the same tested tree.
    commit = git('commit-tree', prTree, '-p', original, '-m', 'Squashed PR');
    git('checkout', '--detach', commit);
    fixture.revision = commit;
    writeFileSync(fixturePath, JSON.stringify(fixture));
    expect(cli('lookup', 'push', {}, env).output).toBe('reused=true\n');

    // Keep the same associated PR/head but change the landed content: reuse must stop.
    writeFileSync(join(repo, 'app.txt'), 'Different main content');
    git('commit', '-am', 'Extra content');
    commit = git('rev-parse', 'HEAD');
    fixture.revision = commit;
    writeFileSync(fixturePath, JSON.stringify(fixture));
    expect(cli('lookup', 'push', {}, env).output).toBe('reused=false\n');
  });
});
