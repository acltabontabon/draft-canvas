#!/usr/bin/env node
// Generate a cask only from the published installer's verified bytes. This tooling never runs in
// the editor; both architectures share the desktop app's signed in-app updater.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function stableVersion(tag) {
  if (!STABLE.test(tag ?? '')) throw new Error(`Not a stable release tag: ${tag}`);
  return tag.slice(1);
}

export function assertPublishedRelease(release, tag) {
  stableVersion(tag);
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false) {
    throw new Error(`Release ${tag} must be published and stable`);
  }
}

// Recheck against the freshly fetched tap on every push attempt: another run may have published
// a newer version while this job downloaded or audited its installers.
export function shouldUpdateCask(current, tag) {
  const next = stableVersion(tag).split('.').map(BigInt);
  if (!current) return true;
  const version = current.match(/^\s*version "(\d+\.\d+\.\d+)"\s*$/m)?.[1];
  if (!version) throw new Error('Existing cask has no stable version');
  const previous = stableVersion(`v${version}`).split('.').map(BigInt);
  for (let at = 0; at < next.length; at++) {
    if (next[at] !== previous[at]) return next[at] > previous[at];
  }
  return true;
}

export function buildCask({ version, armSha256, intelSha256 }) {
  stableVersion(`v${version}`);
  for (const digest of [armSha256, intelSha256]) {
    if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Invalid installer SHA-256');
  }
  return `cask "draft-canvas" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${armSha256}",
         intel: "${intelSha256}"

  url "https://github.com/acltabontabon/draft-canvas/releases/download/v#{version}/Draft-Canvas_#{version}_macOS_#{arch}.dmg"
  name "Draft Canvas"
  desc "Draw software architecture and explain how it works"
  homepage "https://draftcanvas.dev/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "Draft Canvas.app"

  caveats <<~EOS
    For builds without Apple signing and notarization, open Draft Canvas once, then
    System Settings > Privacy & Security > Open Anyway if prompted.
    Homebrew preserves Gatekeeper checks. Draft Canvas updates itself with signed updates.
    Uninstalling this cask leaves your diagrams, Quick Drafts and recovery data alone.
  EOS
end
`;
}

export function caskForRelease(tag, directory) {
  const version = stableVersion(tag);
  const manifest = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/);
  const digestOf = (arch) => {
    const name = `Draft-Canvas_${version}_macOS_${arch}.dmg`;
    const entries = manifest.filter((line) => line.match(/^([a-f0-9]{64}) [ *](.+)$/)?.[2] === name);
    if (entries.length !== 1) throw new Error(`Expected one checksum for ${name}`);
    const digest = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
    if (digest !== entries[0].slice(0, 64)) throw new Error(`Checksum mismatch: ${name}`);
    return digest;
  };
  return buildCask({ version, armSha256: digestOf('arm64'), intelSha256: digestOf('x64') });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, tag, path] = process.argv.slice(2);
    if (!path) throw new Error('Usage: homebrew-cask.mjs generate|check-release|check-update <vX.Y.Z> <path>');
    if (command === 'generate') process.stdout.write(caskForRelease(tag, path));
    else if (command === 'check-release') assertPublishedRelease(JSON.parse(readFileSync(path, 'utf8')), tag);
    else if (command === 'check-update') {
      process.stdout.write(shouldUpdateCask(readFileSync(path, 'utf8'), tag) ? 'update\n' : 'skip\n');
    } else throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
