#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_LICENSES.txt: every package the shipped app and desktop binary carry, with its
 * licence text. The web app ships it in dist/ (including static self-hosting), the desktop app bundles
 * it, and About links to it — an Apache-2.0 project redistributing MIT/BSD/ISC code owes each of
 * those authors their notice, and a hand-kept file is wrong the week after it is written.
 *
 *   npm run licenses              # writes THIRD_PARTY_LICENSES.txt at the repo root
 *   npm run licenses -- --check   # exits 1 if the file on disk differs from what would be written
 *
 * npm: the production dependency closure (`npm ls --omit=dev`), plus the few development packages
 * whose code a build copies into what ships (`BUNDLED_DEV`), each package's `license` field and every
 * LICENSE/LICENCE/COPYING/NOTICE file in its folder — `LICENSE-MIT` and `LICENSE-APACHE` included:
 * most crates ship those two, and matching only a bare `LICENSE` left 385 crates without their text.
 * A text that appears again is printed once and referred to after that. Rust: `cargo metadata` for the desktop crate, each
 * crate's `license` field (and `license-file` when it has one); cargo is optional — without it the
 * Rust section says so instead of silently going missing, and `--check` compares only what could be
 * produced on this machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'THIRD_PARTY_LICENSES.txt');
export const LICENSE_FILES = /^(licen[cs]e|copying|notice)([-_.][\w.-]*)?$/i;

/** Development dependencies whose code is in a shipped build: Workbox's service-worker runtime in the
 * web app (`dist/workbox-*.js`, from vite-plugin-pwa's generateSW) and the Tauri API in the desktop
 * front end. `npm ls --omit=dev` leaves them out because nothing installs them at run time. */
export const BUNDLED_DEV = ['@tauri-apps/api', 'workbox-core', 'workbox-precaching', 'workbox-routing', 'workbox-strategies'];

function run(cmd, args, cwd = root) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    // npm is npm.cmd on Windows, which Node starts only through a shell; the arguments are fixed words.
    shell: process.platform === 'win32' && cmd === 'npm',
  });
}

/** Every licence file in `dir`, by name, with its text. */
export function licenseTextsIn(dir) {
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LICENSE_FILES.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      // LF only: a few packages ship CRLF licence files, and git normalises the committed copy, so a
      // generated CRLF would never match what CI checks out.
      .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').replace(/\r\n?/g, '\n').trim() }))
      .filter((file) => file.text !== '')
  );
}

/** The production npm closure as `{ name, version, license, path }`, sorted, one entry per name@version. */
export function npmPackages() {
  const tree = JSON.parse(run('npm', ['ls', '--omit=dev', '--all', '--json', '--long']));
  const seen = new Map();
  const visit = (deps) => {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (!dep.version) continue;
      const key = `${name}@${dep.version}`;
      if (!seen.has(key)) {
        seen.set(key, { name, version: dep.version, license: dep.license ?? 'UNKNOWN', path: dep.path });
      }
      visit(dep.dependencies);
    }
  };
  visit(tree.dependencies);
  for (const name of BUNDLED_DEV) {
    const path = join(root, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    const key = `${name}@${manifest.version}`;
    if (!seen.has(key)) seen.set(key, { name, version: manifest.version, license: manifest.license ?? 'UNKNOWN', path });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The desktop crate's dependency closure, or `null` when cargo isn't available here. */
export function cargoPackages() {
  const manifest = join(root, 'src-tauri', 'Cargo.toml');
  if (!existsSync(manifest)) return null;
  let metadata;
  try {
    metadata = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--manifest-path', manifest]));
  } catch {
    return null;
  }
  const own = new Set(metadata.workspace_members);
  return metadata.packages
    .filter((pkg) => !own.has(pkg.id))
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'UNKNOWN'),
      path: dirname(pkg.manifest_path),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** `printed` maps each licence text already written to where it was, so a text shared by hundreds of
 * crates (the Apache-2.0 licence above all) is reproduced once. */
function section(title, packages, printed) {
  const lines = [`## ${title}`, ''];
  if (packages === null) {
    lines.push('(cargo was not available when this file was generated; the desktop build regenerates it.)', '');
    return lines;
  }
  for (const pkg of packages) {
    lines.push(`### ${pkg.name} ${pkg.version} — ${pkg.license}`, '');
    const files = licenseTextsIn(pkg.path);
    if (files.length === 0) lines.push('(no licence file in the package; see its registry page)', '');
    for (const file of files) {
      if (files.length > 1) lines.push(`#### ${file.name}`, '');
      const first = printed.get(file.text);
      if (first) {
        lines.push(`(The same text as ${first}, above.)`, '');
      } else {
        printed.set(file.text, `${pkg.name} ${pkg.version}'s ${file.name}`);
        lines.push(file.text, '');
      }
    }
  }
  return lines;
}

export function render() {
  const printed = new Map();
  return [
    '# Third-party licences',
    '',
    'Draft Canvas is Apache-2.0. It ships the following packages, each under its own licence, reproduced',
    'here as their authors require. Generated by scripts/third-party-licenses.mjs; do not edit by hand.',
    '',
    ...section('npm packages (web app, desktop front end)', npmPackages(), printed),
    ...section('Rust crates (desktop app)', cargoPackages(), printed),
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render();
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error('THIRD_PARTY_LICENSES.txt is stale: run `npm run licenses`.');
      process.exit(1);
    }
    console.log('THIRD_PARTY_LICENSES.txt is current.');
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
