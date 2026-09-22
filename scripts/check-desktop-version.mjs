// Fails when the desktop app could ship with a version other than the web app's, or with mismatched
// Tauri pieces. The desktop app has no version of its own: `package.json` is the one source, and
// everything else either points at it or is checked against it here.
//
//   node scripts/check-desktop-version.mjs                       what CI runs on every change
//   node scripts/check-desktop-version.mjs --tag desktop-v1.9.4  the release: the tag must be the version
//   node scripts/check-desktop-version.mjs --tag … --artifacts <dir>  …and every installer must carry it
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const problems = [];
const version = json('package.json').version;

// tauri.conf.json takes its version from package.json by path, so it cannot drift.
const config = json('src-tauri/tauri.conf.json');
if (config.version !== '../package.json') {
  problems.push(`src-tauri/tauri.conf.json "version" must be "../package.json", not ${JSON.stringify(config.version)}: the desktop app takes the web app's version.`);
}

// Cargo.toml's own version is never shown to anyone, so it is a fixed placeholder rather than a second number to keep in step.
const cargo = read('src-tauri/Cargo.toml');
const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargo.slice(cargo.indexOf('[package]')))?.[1];
if (cargoVersion !== '0.0.0') {
  problems.push(`src-tauri/Cargo.toml [package] version must stay "0.0.0" (found ${JSON.stringify(cargoVersion)}); the real version is package.json's.`);
}

// The CLI refuses an @tauri-apps/api whose major.minor differs from the tauri crate it builds.
const minor = (v) => v?.split('.').slice(0, 2).join('.');
const apiVersion = json('package-lock.json').packages?.['node_modules/@tauri-apps/api']?.version;
const crateVersion = existsSync(join(root, 'src-tauri/Cargo.lock'))
  ? /name = "tauri"\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock'))?.[1]
  : undefined;
if (!apiVersion) problems.push('@tauri-apps/api is missing from package-lock.json.');
else if (crateVersion && minor(apiVersion) !== minor(crateVersion)) {
  problems.push(`@tauri-apps/api ${apiVersion} and the tauri crate ${crateVersion} must share a major.minor; update them together.`);
}

// A release is the web app's version. A prerelease (desktop-v1.10.0-alpha.1) may lead it: the desktop app's
// alphas come before the version it ships in, so its X.Y.Z may be package.json's or a later one, never an
// earlier one. The release workflow builds it with the tag's version.
const tag = option('--tag');
if (tag) {
  const tagged = /^desktop-v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag);
  const core = (text) => text.split('-')[0].split('.').map(Number);
  const [a, b, c] = core(version);
  const leads = tagged && (Number(tagged[1]) - a || Number(tagged[2]) - b || Number(tagged[3]) - c) >= 0;
  if (!tagged) {
    problems.push(`The tag ${tag} is not desktop-vX.Y.Z or desktop-vX.Y.Z-<prerelease>.`);
  } else if (!tagged[4] && tag !== `desktop-v${version}`) {
    problems.push(`The tag ${tag} must be desktop-v${version}: the desktop release is the web app's version, so bump package.json first.`);
  } else if (tagged[4] && !leads) {
    problems.push(`The prerelease ${tag} is older than the web app's ${version}: a desktop prerelease leads the version it ships in.`);
  }
}

// The installers carry the version being released: the tag's, when there is one.
const artifacts = option('--artifacts');
if (artifacts) {
  const released = tag ? tag.slice('desktop-v'.length) : version;
  const found = readdirSync(artifacts).filter((name) => statSync(join(artifacts, name)).isFile());
  if (found.length === 0) problems.push(`No installers found in ${artifacts}.`);
  for (const name of found) {
    if (!name.includes(`_${released}_`)) problems.push(`${name} does not carry the version ${released}.`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `✗ ${problem}`).join('\n'));
  process.exit(1);
}
process.stdout.write(`✓ desktop version ${version}${crateVersion ? `, tauri ${crateVersion}, @tauri-apps/api ${apiVersion}` : ''}\n`);
