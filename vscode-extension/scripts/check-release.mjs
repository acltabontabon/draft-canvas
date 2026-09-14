// Checks that a tag is ready to release as Draft Canvas for VS Code, before anything is built or published.
//
//   node scripts/check-release.mjs extension-v0.1.4                 # local checks only
//   node scripts/check-release.mjs extension-v0.1.4 --marketplace   # also compares with the Marketplace
//   node scripts/check-release.mjs extension-v0.1.4 --wait-listed   # waits until the Marketplace lists it
//
// With --marketplace, prints `listed=true|false` (to $GITHUB_OUTPUT too, when set).
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_ID = 'acltabontabon.draft-canvas';
const TAG_PATTERN = /^extension-v(\d+)\.(\d+)\.(\d+)$/;
const QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 20 * 1000;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [tag, mode] = process.argv.slice(2);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (!tag) fail('Usage: node scripts/check-release.mjs <extension-vX.Y.Z> [--marketplace | --wait-listed]');
const match = TAG_PATTERN.exec(tag);
if (!match) fail(`"${tag}" isn't an extension release tag. Extension releases use extension-vX.Y.Z, e.g. extension-v0.1.4.`);
const version = match.slice(1).join('.');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];
if (manifest.version !== version) {
  problems.push(`vscode-extension/package.json is version ${manifest.version}, but the tag is ${tag}. Bump the version and tag the commit that has it.`);
}
if (`${manifest.publisher}.${manifest.name}` !== EXTENSION_ID) {
  problems.push(`vscode-extension/package.json identifies as ${manifest.publisher}.${manifest.name}, not ${EXTENSION_ID}.`);
}
// What the Marketplace needs to list the extension properly.
for (const field of ['displayName', 'description', 'icon', 'license', 'repository', 'engines']) {
  if (!manifest[field]) problems.push(`vscode-extension/package.json has no "${field}", which the Marketplace listing needs.`);
}
if (!manifest.engines?.vscode) problems.push('vscode-extension/package.json has no "engines.vscode".');

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
if (!heading.test(changelog)) {
  problems.push(`vscode-extension/CHANGELOG.md has no dated "## [${version}] - YYYY-MM-DD" section. Move the [Unreleased] entries under one.`);
}
if (problems.length) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`${tag}: ${EXTENSION_ID}@${version}, dated changelog section present.`);

if (!mode) process.exit(0);
if (mode !== '--marketplace' && mode !== '--wait-listed') fail(`Unknown option ${mode}.`);

async function listedVersions() {
  const response = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }], flags: 1 }),
  });
  if (!response.ok) throw new Error(`Marketplace query failed: HTTP ${response.status}`);
  const body = await response.json();
  return (body.results?.[0]?.extensions?.[0]?.versions ?? []).map((entry) => entry.version);
}

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

if (mode === '--wait-listed') {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if ((await listedVersions()).includes(version)) {
      console.log(`${EXTENSION_ID}@${version} is listed on the Marketplace.`);
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.log(`::warning::The Marketplace accepted ${version} but hasn't listed it after ${WAIT_MS / 60000} minutes. It may still be verifying: check https://marketplace.visualstudio.com/manage/publishers/acltabontabon.`);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const versions = await listedVersions();
const listed = versions.includes(version);
if (listed) {
  console.log(`::notice::${EXTENSION_ID}@${version} is already on the Marketplace, so this run won't publish it again.`);
} else {
  const newest = [...versions].sort(compare).at(-1);
  if (newest && compare(version, newest) < 0) {
    fail(`${version} is older than ${newest}, the newest version on the Marketplace. The Marketplace only accepts newer versions.`);
  }
  console.log(`${version} isn't on the Marketplace yet${newest ? ` (newest is ${newest})` : ''}.`);
}
console.log(`listed=${listed}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `listed=${listed}\n`);
