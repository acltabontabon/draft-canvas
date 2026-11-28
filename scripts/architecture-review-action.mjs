// The architecture review action (`action.yml`): fetches the headless CLI a release attached,
// checks that it is the file that release built, runs `draftcanvas review` on the checked-out
// repository and writes the report to the job summary.
//
// What it will not do: run anything from the repository under review, pass a value from the event
// through a shell, or use a CLI it could not verify. The download is the only thing that leaves
// the runner, and it is a GET of a public release asset.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'acltabontabon/draft-canvas';
/** GitHub shows at most 1 MiB of job summary per step; a longer report is cut, and says so. */
export const SUMMARY_LIMIT = 900 * 1024;

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

/** The release to use: the one named, else the tag the action itself was referenced by. */
export function releaseTag(version, actionRef) {
  const named = (version ?? '').trim();
  if (named) {
    if (!TAG.test(named)) throw new Error(`"version" must be a release tag such as v2.0.0, not "${named.slice(0, 60)}".`);
    return named;
  }
  const ref = (actionRef ?? '').trim();
  if (TAG.test(ref)) return ref;
  throw new Error('Name the Draft Canvas release to use with the "version" input (for example v2.0.0), or reference this action by a release tag.');
}

export function assetName(tag) {
  return `Draft-Canvas_${TAG.exec(tag)[1]}_cli.mjs`;
}

/** The checksum a `SHA256SUMS.txt` gives for `name`, or `null` when it lists none. */
export function listedChecksum(sums, name) {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  return null;
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The revision to compare with: the one named, else the pull request's base commit. */
export function baseRevision(named, pullRequestBase) {
  const base = (named ?? '').trim() || (pullRequestBase ?? '').trim();
  if (!base) throw new Error('Nothing to compare with: run this on a pull_request event, or name a revision with the "base" input.');
  return base;
}

function download(tag, dir) {
  const name = assetName(tag);
  mkdirSync(dir, { recursive: true });
  // `gh` is given every value as its own argument; nothing is interpreted by a shell.
  execFileSync('gh', ['release', 'download', tag, '--repo', SOURCE_REPOSITORY, '--pattern', name, '--pattern', 'SHA256SUMS.txt', '--dir', dir, '--clobber'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const file = join(dir, name);
  const expected = listedChecksum(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'), name);
  if (!expected) throw new Error(`Release ${tag} lists no checksum for ${name}. It may predate the command-line tool.`);
  const actual = sha256(file);
  if (actual !== expected) throw new Error(`${name} does not match the checksum release ${tag} published. Expected ${expected}, got ${actual}.`);
  // The checksum says the file is the one the release holds; the attestation says the release
  // workflow of this repository built it.
  execFileSync('gh', ['attestation', 'verify', file, '--repo', SOURCE_REPOSITORY], { stdio: ['ignore', 'inherit', 'inherit'] });
  return file;
}

export function run(env = process.env) {
  const temp = env.RUNNER_TEMP || '.';
  let cli;
  if ((env.DC_CLI ?? '').trim()) {
    cli = resolve(env.DC_CLI.trim());
    if (!existsSync(cli) || !statSync(cli).isFile()) throw new Error(`"cli-path" names ${env.DC_CLI}, which is not a file.`);
  } else {
    cli = download(releaseTag(env.DC_VERSION, env.DC_ACTION_REF), join(temp, 'draft-canvas-cli'));
  }
  const base = baseRevision(env.DC_BASE, env.DC_BASE_SHA);
  const report = join(temp, 'architecture-review.md');
  const args = [cli, 'review', '--repo', (env.DC_REPO ?? '').trim() || '.', '--base', base, '--fail-on', (env.DC_FAIL_ON ?? '').trim() || 'error', '--output', report];
  const result = spawnSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (existsSync(report)) {
    let text = readFileSync(report, 'utf8');
    if (Buffer.byteLength(text) > SUMMARY_LIMIT) text = `${Buffer.from(text).subarray(0, SUMMARY_LIMIT).toString('utf8')}\n\n…the report is longer than a job summary holds; the rest is in the report file.\n`;
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `report=${report}\n`);
  }
  return result.status ?? 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 3;
  }
}
