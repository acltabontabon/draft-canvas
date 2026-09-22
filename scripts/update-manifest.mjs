#!/usr/bin/env node
// Builds, checks and places the manifest Draft Canvas Desktop's updater reads.
//
// Installed copies look in one place, set in src-tauri/tauri.conf.json, with their channel filled in:
//
//   https://github.com/acltabontabon/draft-canvas/releases/download/desktop-updates/{{channel}}.json
//
//   stable.json  the newest stable release. Stable installs read this, so they never see a prerelease.
//   alpha.json   the newest release of any kind. Prerelease installs read this, so an alpha moves on to
//                newer alphas and then to the release they led up to.
//
// `desktop-updates` is one rolling GitHub release holding nothing but those two files. It exists
// because GitHub's own "latest" release is the web app's. Each desktop release also carries the
// manifest it was built with, as its own `latest.json`, which never changes afterwards.
//
// Nothing here talks to the network or to GitHub; the workflows do. This only decides what to say,
// and refuses to say it when anything is missing or doesn't add up — a manifest that names a file
// that isn't there, or a signature made with the wrong key, is an update that fails on every machine.
//
//   node scripts/update-manifest.mjs check-config
//   node scripts/update-manifest.mjs build <version> <artifacts-dir> [--tag <tag>] [--base-url <url>] > latest.json
//   node scripts/update-manifest.mjs check-artifact <file> <version>
//   node scripts/update-manifest.mjs verify <latest.json> <version> [--tag <tag>] [--artifacts <dir>] [--base-url <url>]
//   node scripts/update-manifest.mjs channels <version> --existing <dir> [--force]

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection, unwrap } from './release-notes.mjs';

export { changelogSection };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = 'acltabontabon/draft-canvas';
/** The rolling release installed copies read, and the address they read it at. */
export const CHANNELS_TAG = 'desktop-updates';
export const CHANNELS = ['stable', 'alpha'];
export const ENDPOINT = `https://github.com/${REPO}/releases/download/${CHANNELS_TAG}/{{channel}}.json`;

// ---- what a release must contain -----------------------------------------------------------------

/**
 * The whole matrix: one entry per platform Draft Canvas Desktop ships. Nothing is published unless
 * every one is here, signed. `key` is the name the updater plugin looks for; `file` is what the release
 * workflow names the update package — the app bundle as `.app.tar.gz` on macOS (the updater replaces
 * the bundle and can't use a disk image), and the NSIS installer itself on Windows.
 */
export const PLATFORMS = [
  { key: 'darwin-aarch64', label: 'macOS (Apple silicon)', file: (version) => `Draft-Canvas_${version}_macOS_arm64.app.tar.gz` },
  { key: 'windows-x86_64', label: 'Windows (x64)', file: (version) => `Draft-Canvas_${version}_Windows_x64.exe` },
];

/**
 * The tag a version is released under: a release is `vX.Y.Z` (web, Docker and desktop together), a
 * desktop preview ahead of one is `desktop-vX.Y.Z-alpha.N`. The workflows pass the tag they run for.
 */
export const releaseTag = (version) => (isPrerelease(version) ? `desktop-v${version}` : `v${version}`);

/** Where a release's file lives. `baseUrl` is only for testing against a local server. */
export const assetUrl = (version, file, baseUrl = null, tag = releaseTag(version)) =>
  `${baseUrl ? baseUrl.replace(/\/+$/, '') : `https://github.com/${REPO}/releases/download/${tag}`}/${file}`;

// ---- versions -------------------------------------------------------------------------------------

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** A parsed semantic version, or null. Build metadata is dropped: it has no precedence. */
export function parseVersion(text) {
  const match = typeof text === 'string' ? SEMVER.exec(text) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] };
}

/** Semver precedence, -1, 0 or 1 — never a comparison of the text (`1.10.0` is newer than `1.9.4`). */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const field of ['major', 'minor', 'patch']) {
    if (x[field] !== y[field]) return x[field] < y[field] ? -1 : 1;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  const isNumber = (part) => /^\d+$/.test(part);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (isNumber(p) && isNumber(q)) return Number(p) < Number(q) ? -1 : 1;
    if (isNumber(p)) return -1;
    if (isNumber(q)) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (version) => (parseVersion(version)?.pre.length ?? 0) > 0;

// ---- minisign -------------------------------------------------------------------------------------
//
// The updater verifies downloads with minisign signatures; the Tauri CLI writes them, base64-encoded,
// into `.sig` files, and the same base64 goes into the manifest. Checking them here, natively, means
// the release needs no extra tool and can prove — before anything is published — that what it's about
// to offer will pass the check on somebody's machine.

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const b64 = (text) => Buffer.from(String(text).trim(), 'base64');
const lines = (buffer) =>
  buffer
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '');

/** The key id and key of a Tauri public key (the base64 of a minisign `.pub` file). */
export function decodePublicKey(pubkey) {
  const parts = lines(b64(pubkey));
  const raw = parts.length >= 2 ? b64(parts[1]) : Buffer.alloc(0);
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not a minisign public key');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

/** The parts of a Tauri signature (the base64 of a minisign `.sig` file). */
export function decodeSignature(signature) {
  const parts = lines(b64(signature));
  if (parts.length < 4) throw new Error('not a minisign signature');
  const raw = b64(parts[1]);
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (raw.length !== 74 || (algorithm !== 'Ed' && algorithm !== 'ED')) throw new Error('not a minisign signature');
  const prefix = 'trusted comment: ';
  if (!parts[2].startsWith(prefix)) throw new Error('signature has no trusted comment');
  const global = b64(parts[3]);
  if (global.length !== 64) throw new Error('signature has no global signature');
  return { algorithm, keyId: raw.subarray(2, 10), signature: raw.subarray(10), trustedComment: parts[2].slice(prefix.length), globalSignature: global };
}

/** The version a signature says it was made for, or null. */
export function signedVersion(trustedComment) {
  for (const field of trustedComment.split('\t')) {
    if (field.startsWith('version:')) return field.slice('version:'.length);
  }
  return null;
}

/**
 * Whether `signature` is a valid signature of `data` by the key in `pubkey`, and if not, why. Checks
 * both signatures a minisign file carries: the one over the file, and the global one that makes the
 * trusted comment — where the signed version lives — trustworthy too.
 */
export function verifySignature(data, signature, pubkey) {
  let pub;
  let sig;
  try {
    pub = decodePublicKey(pubkey);
    sig = decodeSignature(signature);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (!pub.keyId.equals(sig.keyId)) return { ok: false, reason: 'signed with a different key than the one in the app' };
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub.key]), format: 'der', type: 'spki' });
  const message = sig.algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!edVerify(null, message, key, sig.signature)) return { ok: false, reason: 'the signature does not match the file' };
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!edVerify(null, global, key, sig.globalSignature)) return { ok: false, reason: 'the signature’s comment has been altered' };
  return { ok: true, trustedComment: sig.trustedComment, version: signedVersion(sig.trustedComment) };
}

// ---- the manifest ---------------------------------------------------------------------------------

/** The manifest for one release. Throws when anything the release needs is missing. */
export function buildManifest({ version, notes, pubDate, signatures, baseUrl = null, tag = releaseTag(version) }) {
  if (!parseVersion(version)) throw new Error(`"${version}" is not a semantic version`);
  const platforms = {};
  for (const platform of PLATFORMS) {
    const signature = signatures[platform.key];
    if (typeof signature !== 'string' || signature.trim() === '') {
      throw new Error(`no signature for ${platform.label} (${platform.file(version)}.sig)`);
    }
    platforms[platform.key] = { signature: signature.trim(), url: assetUrl(version, platform.file(version), baseUrl, tag) };
  }
  return { version, notes: notes ?? '', pub_date: pubDate, platforms };
}

/** Everything wrong with a manifest, as sentences. Empty means it can be published. */
export function manifestProblems(manifest, { version, pubkey, artifacts = null, requireSignedVersion = true, baseUrl = null, tag = releaseTag(version) }) {
  const problems = [];
  const add = (text) => problems.push(text);
  if (!manifest || typeof manifest !== 'object') return ['the manifest is not an object'];
  if (manifest.version !== version) add(`version is "${manifest.version}", expected "${version}"`);
  if (!parseVersion(manifest.version)) add(`"${manifest.version}" is not a semantic version`);
  if (typeof manifest.notes !== 'string') add('notes is not a string');
  if (typeof manifest.pub_date !== 'string' || Number.isNaN(Date.parse(manifest.pub_date))) add('pub_date is not an RFC 3339 date');

  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== 'object') {
    add('platforms is missing');
    return problems;
  }
  const expected = new Set(PLATFORMS.map((p) => p.key));
  for (const key of Object.keys(platforms)) {
    if (!expected.has(key)) add(`unexpected platform "${key}"`);
  }

  let publicKey = null;
  try {
    publicKey = decodePublicKey(pubkey);
  } catch {
    add('the public key is not a valid minisign key');
  }

  for (const platform of PLATFORMS) {
    const entry = platforms[platform.key];
    const name = `${platform.label} (${platform.key})`;
    if (!entry) {
      add(`${name} is missing`);
      continue;
    }
    const file = platform.file(version);
    const wantUrl = assetUrl(version, file, baseUrl, tag);
    if (typeof entry.url !== 'string' || (!baseUrl && !entry.url.startsWith('https://'))) add(`${name}: the URL is not https`);
    else if (entry.url !== wantUrl) add(`${name}: the URL is ${entry.url}, expected ${wantUrl}`);

    if (typeof entry.signature !== 'string' || entry.signature.trim() === '') {
      add(`${name}: there is no signature`);
      continue;
    }
    let decoded;
    try {
      decoded = decodeSignature(entry.signature);
    } catch (error) {
      add(`${name}: ${error.message}`);
      continue;
    }
    if (publicKey && !publicKey.keyId.equals(decoded.keyId)) {
      add(`${name}: signed with a different key than the one in the app`);
      continue;
    }
    // The app refuses a signature that doesn't say which version it was made for. A release signed
    // without it would fail on every machine, so it's caught here instead.
    if (requireSignedVersion) {
      const signed = signedVersion(decoded.trustedComment);
      if (signed === null) add(`${name}: the signature does not record a version, which the app requires`);
      else if (signed !== version) add(`${name}: the signature was made for version ${signed}`);
    }
    if (artifacts) {
      const path = join(artifacts, file);
      if (!existsSync(path)) add(`${name}: ${file} is not in ${artifacts}`);
      else {
        const outcome = verifySignature(readFileSync(path), entry.signature, pubkey);
        if (!outcome.ok) add(`${name}: ${file} does not verify — ${outcome.reason}`);
      }
    }
  }
  return problems;
}

/**
 * Which channels a release is written to. A stable release goes to both — stable installs get it, and
 * alphas move on to it — and a prerelease to alpha only. A channel only ever moves forward; `force`
 * exists for pointing back at an older release on purpose, when a newer one was bad. `existing` maps a
 * channel to the manifest it holds now, if any.
 */
export function channelsToWrite({ version, existing = {}, force = false }) {
  const wanted = isPrerelease(version) ? ['alpha'] : ['stable', 'alpha'];
  return wanted.filter((channel) => {
    const current = existing[channel]?.version;
    if (force || !current || !parseVersion(current)) return true;
    return compareVersions(version, current) > 0;
  });
}

// ---- the app's own configuration --------------------------------------------------------------------

export function readUpdaterConfig(path = join(root, 'src-tauri/tauri.conf.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).plugins?.updater ?? null;
}

/** Problems that mean this checkout can't ship a working updater. */
export function configProblems(updater) {
  if (!updater) return ['plugins.updater is missing from src-tauri/tauri.conf.json'];
  const problems = [];
  try {
    const { keyId } = decodePublicKey(updater.pubkey ?? '');
    if (keyId.every((byte) => byte === 0)) problems.push('the public key has an empty key id');
  } catch {
    problems.push('plugins.updater.pubkey is not a real public key yet — see docs/guides/desktop-updates.md');
  }
  const endpoints = updater.endpoints ?? [];
  if (endpoints.length !== 1 || endpoints[0] !== ENDPOINT) problems.push(`the one endpoint must be ${ENDPOINT}`);
  if (updater.requireSignedVersion !== true) problems.push('requireSignedVersion is not on, which leaves a package pairable with another version’s manifest');
  if (updater.dangerousInsecureTransportProtocol) problems.push('dangerousInsecureTransportProtocol must never be on in the shipped configuration');
  return problems;
}

// ---- command line ---------------------------------------------------------------------------------

function flags(args) {
  const positional = [];
  const named = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const name = args[i].slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) named[name] = true;
      else {
        named[name] = next;
        i++;
      }
    } else positional.push(args[i]);
  }
  return { positional, named };
}

function fail(messages) {
  for (const line of [].concat(messages)) console.error(`::error::${line}`);
  process.exit(1);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, named } = flags(rest);
  const baseUrl = typeof named['base-url'] === 'string' ? named['base-url'] : null;
  const tagFor = (version) => (typeof named.tag === 'string' ? named.tag : releaseTag(version));

  switch (command) {
    case 'check-config': {
      const problems = configProblems(readUpdaterConfig());
      if (problems.length) fail(problems);
      console.error('The updater configuration is complete.');
      return;
    }
    case 'build': {
      const [version, dir] = positional;
      if (!version || !dir) fail('Usage: build <version> <artifacts-dir>');
      const signatures = {};
      for (const platform of PLATFORMS) {
        const path = join(dir, `${platform.file(version)}.sig`);
        if (existsSync(path)) signatures[platform.key] = readFileSync(path, 'utf8');
      }
      const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
      try {
        const manifest = buildManifest({
          version,
          // Unwrapped, as the release page shows it: the in-app panel reads it the same way.
          notes: unwrap(changelogSection(changelog, version) ?? ''),
          pubDate: new Date().toISOString(),
          signatures,
          baseUrl,
          tag: tagFor(version),
        });
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      } catch (error) {
        fail(error.message);
      }
      return;
    }
    case 'check-artifact': {
      // One package against its own `.sig`, on the machine that built it: the earliest point a wrong
      // key, a missing signature or an unbound version can be caught.
      const [file, version] = positional;
      if (!file || !version) fail('Usage: check-artifact <file> <version>');
      const updater = readUpdaterConfig();
      if (!existsSync(file)) fail(`${file} does not exist`);
      if (!existsSync(`${file}.sig`)) fail(`${file}.sig does not exist — the build did not sign it`);
      const outcome = verifySignature(readFileSync(file), readFileSync(`${file}.sig`, 'utf8'), updater?.pubkey ?? '');
      if (!outcome.ok) fail(`${file} does not verify: ${outcome.reason}`);
      if (updater?.requireSignedVersion === true && outcome.version !== version) {
        fail(`${file} was signed for version ${outcome.version ?? '(none)'}, expected ${version}`);
      }
      console.error(`${file} verifies against the key in the app, signed for ${outcome.version}.`);
      return;
    }
    case 'verify': {
      const [file, version] = positional;
      if (!file || !version) fail('Usage: verify <latest.json> <version> [--artifacts <dir>]');
      const updater = readUpdaterConfig();
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        fail(`${file} is not valid JSON: ${error.message}`);
      }
      const problems = manifestProblems(manifest, {
        version,
        pubkey: updater?.pubkey ?? '',
        artifacts: typeof named.artifacts === 'string' ? named.artifacts : null,
        requireSignedVersion: updater?.requireSignedVersion === true,
        baseUrl,
        tag: tagFor(version),
      });
      if (problems.length) fail(problems);
      console.error(`${file} is complete: ${PLATFORMS.length} platforms, every signature checked${named.artifacts ? ' against its file' : ''}.`);
      return;
    }
    case 'channels': {
      // Prints the channel files to write, one per line, for the workflow to act on.
      const [version] = positional;
      if (!version) fail('Usage: channels <version> --existing <dir> [--force]');
      const existing = {};
      for (const channel of CHANNELS) {
        const path = typeof named.existing === 'string' ? join(named.existing, `${channel}.json`) : null;
        if (!path || !existsSync(path)) continue;
        try {
          existing[channel] = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          // A channel nobody can read is one worth replacing.
        }
      }
      const write = channelsToWrite({ version, existing, force: Boolean(named.force) });
      process.stdout.write(write.map((channel) => `${channel}.json\n`).join(''));
      return;
    }
    default:
      fail('Usage: update-manifest.mjs <check-config|build|check-artifact|verify|channels> …');
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
