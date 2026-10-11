import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = /^[a-f0-9]{40}$/;
const workflows = new Set(['ci.yml', 'desktop-ci.yml']);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
const evidenceName = (workflow, run) => `ci-evidence-${workflow}-${run.id}-${run.run_attempt}`;

// Evidence is data only. Never restore a PR build or execute files downloaded from a PR run.
export function findReusableRun({ repository, revision, tree, full, workflow, event, api, evidence }) {
  const pulls = api(`repos/${repository}/commits/${revision}/pulls?per_page=10`);
  for (const associated of pulls) {
    const pull = api(`repos/${repository}/pulls/${associated.number}`);
    if (!pull.merged || pull.merge_commit_sha !== revision || pull.base.ref !== event.repository.default_branch
      || pull.base.repo.full_name !== repository || pull.head.repo?.full_name !== repository) continue;

    // GitHub reports the PR head here, not the temporary merge commit that checkout tested.
    const runs = api(`repos/${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=10`);
    for (const run of runs.workflow_runs) {
      if (run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'pull_request'
        || run.path !== `.github/workflows/${workflow}` || run.repository.full_name !== repository
        || run.head_sha !== pull.head.sha || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)) continue;
      try {
        const proof = evidence(run, evidenceName(workflow, run));
        if (proof.version !== 1 || proof.repository !== repository || proof.workflow !== workflow
          || proof.runId !== run.id || proof.attempt !== run.run_attempt || proof.pull !== pull.number
          || proof.head !== run.head_sha || typeof proof.full !== 'boolean' || (full && !proof.full)
          || !sha.test(proof.revision ?? '') || !sha.test(proof.base ?? '') || proof.tree !== tree) continue;
        // Resolve the recorded commit independently: a claimed tree or a head-only check is insufficient.
        const tested = api(`repos/${repository}/git/commits/${proof.revision}`);
        if (tested.sha !== proof.revision || tested.tree.sha !== tree || tested.parents.length !== 2
          || tested.parents[0].sha !== proof.base || tested.parents[1].sha !== proof.head) continue;
        return { id: run.id, url: `https://github.com/${repository}/actions/runs/${run.id}` };
      } catch {
        // Old runs may lack evidence, or their artifacts/temporary merge commits may have expired.
      }
    }
  }
  return null;
}

function record(workflow, event) {
  const revision = process.env.SOURCE_REVISION;
  const full = process.env.CI_FULL;
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !sha.test(revision ?? '')
    || git('rev-parse', 'HEAD') !== revision || !['true', 'false'].includes(full)) {
    throw new Error('Evidence must describe the PR source actually checked out.');
  }
  // Event base metadata can lag behind the generated merge. Raw headers retain parents even
  // in checkout's shallow clone; Git's formatted history can hide them at the shallow boundary.
  const parents = git('cat-file', '-p', 'HEAD').split('\n\n', 1)[0].split('\n')
    .filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  if (parents.length !== 2 || parents[1] !== event.pull_request.head.sha) {
    throw new Error('Evidence requires the tested PR merge and its actual head.');
  }
  writeFileSync('ci-evidence.json', JSON.stringify({
    version: 1,
    repository: process.env.GITHUB_REPOSITORY,
    workflow,
    runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    pull: event.pull_request.number,
    head: event.pull_request.head.sha,
    base: parents[0],
    revision,
    tree: git('rev-parse', 'HEAD^{tree}'),
    full: full === 'true',
  }));
}

function lookup(workflow, event) {
  // Release/reusable callers and manual runs always produce freshly verified artifacts.
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.FORCE_FULL === 'true'
    || event.ref !== `refs/heads/${event.repository.default_branch}` || event.after !== process.env.SOURCE_REVISION
    || event.forced || event.created || event.deleted || !sha.test(event.before ?? '') || /^0+$/.test(event.before)) return null;

  const repository = process.env.GITHUB_REPOSITORY;
  const revision = process.env.SOURCE_REVISION;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !sha.test(revision ?? '') || git('rev-parse', 'HEAD') !== revision) {
    throw new Error('Reuse must start from the triggering repository and revision.');
  }
  // Bound the entire lookup so API outages fall back before the source job's timeout.
  const deadline = Date.now() + 90_000;
  const gh = (...args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('CI reuse lookup timed out.');
    return execFileSync('gh', args, { encoding: 'utf8', stdio: 'pipe', timeout: Math.min(15_000, remaining) });
  };
  const api = (path) => JSON.parse(gh('api', path));
  return findReusableRun({
    repository, revision, tree: git('rev-parse', 'HEAD^{tree}'), full: process.env.CI_FULL === 'true', workflow, event, api,
    evidence: (run, name) => {
      const artifacts = api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts
        .filter((artifact) => artifact.name === name && !artifact.expired && artifact.size_in_bytes <= 16_384);
      if (artifacts.length !== 1) throw new Error('No usable CI evidence artifact.');
      const directory = mkdtempSync(join(tmpdir(), 'draft-canvas-ci-evidence-'));
      try {
        gh('run', 'download', String(run.id), '--repo', repository, '--name', name, '--dir', directory);
        const file = join(directory, 'ci-evidence.json');
        if (statSync(file).size > 8_192) throw new Error('Oversized CI evidence.');
        return JSON.parse(readFileSync(file, 'utf8'));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, workflow] = process.argv.slice(2);
  try {
    if (!workflows.has(workflow) || !['record', 'lookup'].includes(mode)) throw new Error('Unknown CI evidence command.');
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (mode === 'record') {
      record(workflow, event);
    } else {
      let reused = null;
      try {
        reused = lookup(workflow, event);
      } catch (error) {
        console.warn(`Could not reuse PR verification; running checks: ${error.message}`);
      }
      appendFileSync(process.env.GITHUB_OUTPUT, `reused=${Boolean(reused)}\n`);
      const message = reused ? `Reusing successful PR verification: ${reused.url}` : 'No matching successful PR verification; running checks.';
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    }
  } catch (error) {
    console.error(error.message);
    // Even missing/malformed event metadata must leave the normal checks enabled.
    if (mode === 'lookup') appendFileSync(process.env.GITHUB_OUTPUT, 'reused=false\n');
    else process.exitCode = 1;
  }
}
