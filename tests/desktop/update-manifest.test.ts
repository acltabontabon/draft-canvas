import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENDPOINT,
  PLATFORMS,
  assetUrl,
  buildManifest,
  changelogSection,
  channelsToWrite,
  compareVersions,
  configProblems,
  manifestProblems,
  releaseTag,
  verifySignature,
} from '../../scripts/update-manifest.mjs';
import { releaseBody, unwrap } from '../../scripts/release-notes.mjs';

/**
 * A minisign key and signatures made the way the Tauri bundler makes them — prehashed ("ED"), with the
 * version in the trusted comment — so every path through the checks runs against real Ed25519
 * signatures rather than stand-ins.
 */
function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pubFile = `untrusted comment: minisign public key: ${keyId.toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
  return { pubkey: Buffer.from(pubFile).toString('base64'), privateKey, keyId };
}

function signWith(key: { privateKey: KeyObject; keyId: Buffer }, data: Buffer, comment: string): string {
  const signature = sign(null, createHash('blake2b512').update(data).digest(), key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), key.privateKey);
  const file = [
    'untrusted comment: signature from tauri secret key',
    Buffer.concat([Buffer.from('ED'), key.keyId, signature]).toString('base64'),
    `trusted comment: ${comment}`,
    global.toString('base64'),
    '',
  ].join('\n');
  return Buffer.from(file).toString('base64');
}

const VERSION = '1.10.0';
const key = makeKey();

/** A release's update packages on disk, each with its `.sig`, as the build leaves them. */
function release(version = VERSION, signer = key, signedFor = version) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-update-'));
  const signatures: Record<string, string> = {};
  for (const platform of PLATFORMS) {
    const data = Buffer.from(`${platform.key} package ${version}`);
    writeFileSync(join(dir, platform.file(version)), data);
    signatures[platform.key] = signWith(signer, data, `timestamp:1790000000\tfile:${platform.file(version)}\tversion:${signedFor}`);
  }
  return { dir, signatures };
}

describe('the update manifest', () => {
  it('names every platform’s package at the address the release will have', () => {
    const { signatures } = release();
    const manifest = buildManifest({ version: VERSION, notes: '### Added', pubDate: '2026-09-22T00:00:00.000Z', signatures });
    expect(Object.keys(manifest.platforms).sort()).toEqual(['darwin-aarch64', 'windows-x86_64']);
    // A release is the one vX.Y.Z release the web app and Docker share.
    expect(manifest.platforms['darwin-aarch64']!.url).toBe(
      'https://github.com/acltabontabon/draft-canvas/releases/download/v1.10.0/Draft-Canvas_1.10.0_macOS_arm64.app.tar.gz',
    );
    expect(manifest.platforms['windows-x86_64']!.url).toBe(assetUrl(VERSION, 'Draft-Canvas_1.10.0_Windows_x64.exe'));
  });

  it('addresses a desktop preview under its own tag', () => {
    expect(releaseTag('1.10.0')).toBe('v1.10.0');
    expect(releaseTag('1.10.0-alpha.2')).toBe('desktop-v1.10.0-alpha.2');
    expect(assetUrl('1.10.0-alpha.2', 'x.exe')).toBe('https://github.com/acltabontabon/draft-canvas/releases/download/desktop-v1.10.0-alpha.2/x.exe');
    expect(assetUrl('1.11.0-rc.1', 'x.exe', null, 'v1.11.0-rc.1')).toBe('https://github.com/acltabontabon/draft-canvas/releases/download/v1.11.0-rc.1/x.exe');
  });

  it('refuses to build without every signature', () => {
    const { signatures } = release();
    delete signatures['windows-x86_64'];
    expect(() => buildManifest({ version: VERSION, pubDate: 'now', signatures })).toThrow(/Windows/);
  });

  it('passes a complete release, checked against the files themselves', () => {
    const { dir, signatures } = release();
    const manifest = buildManifest({ version: VERSION, notes: '', pubDate: '2026-09-22T00:00:00.000Z', signatures });
    expect(manifestProblems(manifest, { version: VERSION, pubkey: key.pubkey, artifacts: dir })).toEqual([]);
  });

  it('catches a package that changed after it was signed', () => {
    const { dir, signatures } = release();
    const manifest = buildManifest({ version: VERSION, notes: '', pubDate: '2026-09-22T00:00:00.000Z', signatures });
    writeFileSync(join(dir, PLATFORMS[0]!.file(VERSION)), 'something else');
    expect(manifestProblems(manifest, { version: VERSION, pubkey: key.pubkey, artifacts: dir })).toEqual([
      expect.stringMatching(/does not verify — the signature does not match the file/),
    ]);
  });

  it('catches a signature from another key, or for another version', () => {
    const other = makeKey();
    const foreign = release(VERSION, other);
    const signedByOther = buildManifest({ version: VERSION, notes: '', pubDate: '2026-09-22T00:00:00.000Z', signatures: foreign.signatures });
    expect(manifestProblems(signedByOther, { version: VERSION, pubkey: key.pubkey })).toEqual(
      PLATFORMS.map(() => expect.stringMatching(/different key/)),
    );

    const stale = release(VERSION, key, '1.9.4');
    const wrongVersion = buildManifest({ version: VERSION, notes: '', pubDate: '2026-09-22T00:00:00.000Z', signatures: stale.signatures });
    expect(manifestProblems(wrongVersion, { version: VERSION, pubkey: key.pubkey })).toEqual(
      PLATFORMS.map(() => expect.stringMatching(/made for version 1\.9\.4/)),
    );
  });

  it('catches a missing platform, an extra one, and an address that isn’t this release’s', () => {
    const { signatures } = release();
    const manifest = buildManifest({ version: VERSION, notes: '', pubDate: '2026-09-22T00:00:00.000Z', signatures });
    delete manifest.platforms['windows-x86_64'];
    manifest.platforms['linux-x86_64'] = { signature: 'x', url: 'https://example.com' };
    manifest.platforms['darwin-aarch64']!.url = 'http://example.com/app.tar.gz';
    const problems = manifestProblems(manifest, { version: VERSION, pubkey: key.pubkey });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unexpected platform "linux-x86_64"/),
        expect.stringMatching(/Windows .* is missing/),
        expect.stringMatching(/not https/),
      ]),
    );
  });

  it('verifies a signature made the bundler’s way, and says which version it was for', () => {
    const data = Buffer.from('bytes');
    const outcome = verifySignature(data, signWith(key, data, 'timestamp:1\tfile:x\tversion:1.10.0'), key.pubkey);
    expect(outcome).toEqual({ ok: true, trustedComment: 'timestamp:1\tfile:x\tversion:1.10.0', version: '1.10.0' });
  });

  it('refuses a signature whose trusted comment was edited', () => {
    const data = Buffer.from('bytes');
    const decoded = Buffer.from(signWith(key, data, 'timestamp:1\tversion:1.9.4'), 'base64').toString().replace('version:1.9.4', 'version:9.9.9');
    const outcome = verifySignature(data, Buffer.from(decoded).toString('base64'), key.pubkey);
    expect(outcome).toEqual({ ok: false, reason: 'the signature’s comment has been altered' });
  });
});

describe('the channels installed copies read', () => {
  it('puts a stable release on both, so alphas move on to it', () => {
    expect(channelsToWrite({ version: '1.10.0' })).toEqual(['stable', 'alpha']);
    expect(channelsToWrite({ version: '1.10.0', existing: { stable: { version: '1.9.4' }, alpha: { version: '1.10.0-alpha.3' } } })).toEqual([
      'stable',
      'alpha',
    ]);
  });

  it('puts a prerelease on alpha only: stable installs never see it', () => {
    expect(channelsToWrite({ version: '1.10.0-alpha.1' })).toEqual(['alpha']);
    expect(channelsToWrite({ version: '1.10.0-alpha.2', existing: { alpha: { version: '1.10.0-alpha.1' } } })).toEqual(['alpha']);
  });

  it('only ever moves forward, unless forced', () => {
    expect(channelsToWrite({ version: '1.10.0-alpha.2', existing: { alpha: { version: '1.10.0' } } })).toEqual([]);
    expect(channelsToWrite({ version: '1.9.5', existing: { stable: { version: '1.10.0' }, alpha: { version: '1.10.0' } } })).toEqual([]);
    expect(channelsToWrite({ version: '1.9.5', existing: { stable: { version: '1.10.0' } }, force: true })).toEqual(['stable', 'alpha']);
  });

  it('compares versions by precedence, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.4')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0-beta.9')).toBe(1);
    expect(compareVersions('2.0.0-beta.10', '2.0.0-beta.9')).toBe(1);
  });
});

describe('the app’s updater configuration', () => {
  const good = { pubkey: key.pubkey, endpoints: [ENDPOINT], requireSignedVersion: true };

  it('is ready with a real key, the channel endpoint and signed versions', () => {
    expect(configProblems(good)).toEqual([]);
  });

  it('is not ready with the placeholder, another endpoint, or version binding off', () => {
    expect(configProblems({ ...good, pubkey: 'UNSET: …' })).toEqual([expect.stringMatching(/not a real public key/)]);
    expect(configProblems({ ...good, endpoints: ['http://localhost/latest.json'] })).toEqual([expect.stringMatching(/one endpoint/)]);
    expect(configProblems({ ...good, requireSignedVersion: false })).toEqual([expect.stringMatching(/requireSignedVersion/)]);
    expect(configProblems({ ...good, dangerousInsecureTransportProtocol: true })).toEqual([expect.stringMatching(/never be on/)]);
  });

  it('matches what tauri.conf.json says, apart from the key', () => {
    const shipped = JSON.parse(readFileSync(join(__dirname, '../../src-tauri/tauri.conf.json'), 'utf8')).plugins.updater;
    expect(configProblems({ ...shipped, pubkey: key.pubkey })).toEqual([]);
  });
});

describe('release notes', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- Next',
    '',
    '## [1.10.0-alpha.1] - 2026-09-22',
    '',
    'The first alpha, a preview',
    'of 1.10.0.',
    '',
    '- A bullet that',
    '  wraps.',
    '',
    '## [1.10.0] - 2026-09-30',
    '',
    '### Added',
    '',
    '- Updates.',
    '',
    '## [1.9.4] - 2026-09-21',
    '',
    '- Older.',
    '',
  ].join('\n');

  it('are the version’s own section of the one changelog', () => {
    expect(changelogSection(changelog, '1.10.0')).toBe('### Added\n\n- Updates.');
    expect(changelogSection(changelog, '9.9.9')).toBeNull();
  });

  it('flow wrapped lines back together, since a release page breaks at every newline', () => {
    expect(unwrap(changelogSection(changelog, '1.10.0-alpha.1')!)).toBe('The first alpha, a preview of 1.10.0.\n\n- A bullet that wraps.');
  });

  it('lead a release with the ways to get it, and a desktop preview with only its section', () => {
    const release = releaseBody('v1.10.0', changelog);
    expect(release).toMatch(/^!\[Draft Canvas demo\]\(https:\/\/raw\.githubusercontent\.com\/acltabontabon\/draft-canvas\/v1\.10\.0\//);
    expect(release).toContain('### Get it');
    expect(release).toContain('acltabontabon/draft-canvas:1.10.0');
    expect(release).toContain('### Opening the desktop app the first time');

    const preview = releaseBody('desktop-v1.10.0-alpha.1', changelog);
    expect(preview.startsWith('The first alpha, a preview of 1.10.0.')).toBe(true);
    expect(preview).not.toContain('### Get it');
    expect(preview).toContain('### Opening the desktop app the first time');

    expect(() => releaseBody('v9.9.9', changelog)).toThrow(/no "## \[9\.9\.9\]" section/);
  });

  it('exist for every version the changelog lists', () => {
    const real = readFileSync(join(__dirname, '../../CHANGELOG.md'), 'utf8');
    expect(() => releaseBody('desktop-v1.10.0-alpha.1', real)).not.toThrow();
    expect(() => releaseBody('v1.9.4', real)).not.toThrow();
  });
});
