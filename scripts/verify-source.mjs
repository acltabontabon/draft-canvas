import { execFileSync } from 'node:child_process';

// This script must come from the workflow's own checkout, before switching to a caller's ref.
// A manual run on main can write main's caches even with a read-only GITHUB_TOKEN. Resolve an
// alternate source only after proving it is part of the repository's reviewed default history.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  const workflow = process.env.WORKFLOW_REVISION;
  if (!workflow || git('rev-parse', 'HEAD') !== workflow) {
    throw new Error('Source verification must start from the workflow revision.');
  }
  const source = process.env.SOURCE_REF || workflow;
  if (source.startsWith('-') || /\s/.test(source)) throw new Error('Invalid source ref.');
  if (source === workflow) {
    console.log(workflow);
  } else {
    const branch = process.env.DEFAULT_BRANCH;
    if (!branch) throw new Error('The repository default branch is required.');
    const trusted = 'refs/remotes/origin/verified-default';
    const unshallow = git('rev-parse', '--is-shallow-repository') === 'true' ? ['--unshallow'] : [];
    git('fetch', '--no-tags', ...unshallow, '--', 'origin', `+refs/heads/${branch}:${trusted}`);
    git('fetch', '--no-tags', '--', 'origin', source);
    const revision = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    try {
      git('merge-base', '--is-ancestor', revision, trusted);
    } catch {
      throw new Error('The selected source is outside the repository default branch history.');
    }
    console.log(revision);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
