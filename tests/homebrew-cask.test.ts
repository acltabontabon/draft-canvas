import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPublishedRelease, buildCask, caskForRelease, shouldUpdateCask, stableVersion } from '../scripts/homebrew-cask.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function installers() {
  const dir = mkdtempSync(join(tmpdir(), 'draft-canvas-homebrew-'));
  dirs.push(dir);
  const lines = ['arm64', 'x64'].map((arch) => {
    const name = `Draft-Canvas_1.13.1_macOS_${arch}.dmg`;
    writeFileSync(join(dir, name), arch);
    return `${hash(arch)}  ${name}`;
  });
  writeFileSync(join(dir, 'SHA256SUMS.txt'), lines.join('\n'));
  return dir;
}

describe('Homebrew publication', () => {
  it('uses the verified bytes for both architecture-specific installers', () => {
    const cask = caskForRelease('v1.13.1', installers());
    expect(cask).toContain('arch arm: "arm64", intel: "x64"');
    expect(cask).toContain(`sha256 arm:   "${hash('arm64')}"`);
    expect(cask).toContain(`intel: "${hash('x64')}"`);
    expect(cask).toContain('Draft-Canvas_#{version}_macOS_#{arch}.dmg');
    expect(cask).toContain('depends_on macos: :monterey');
    expect(cask).toContain('auto_updates true');
    expect(cask).toContain('app "Draft Canvas.app"');
    expect(cask).not.toMatch(/^\s*(zap|uninstall|preflight|postflight)\b|xattr|quarantine/m);
  });

  it('rejects a tampered installer and missing or ambiguous manifest entries', () => {
    const dir = installers();
    const manifest = join(dir, 'SHA256SUMS.txt');
    const original = readFileSync(manifest, 'utf8');
    writeFileSync(join(dir, 'Draft-Canvas_1.13.1_macOS_arm64.dmg'), 'tampered');
    expect(() => caskForRelease('v1.13.1', dir)).toThrow('Checksum mismatch');
    writeFileSync(join(dir, 'Draft-Canvas_1.13.1_macOS_arm64.dmg'), 'arm64');
    writeFileSync(manifest, original.split('\n')[0]!);
    expect(() => caskForRelease('v1.13.1', dir)).toThrow('Expected one checksum');
    writeFileSync(manifest, `${original}\n${original}`);
    expect(() => caskForRelease('v1.13.1', dir)).toThrow('Expected one checksum');
    writeFileSync(manifest, original);
    rmSync(join(dir, 'Draft-Canvas_1.13.1_macOS_x64.dmg'));
    expect(() => caskForRelease('v1.13.1', dir)).toThrow();
  });

  it('rejects draft, preview, mismatched and malformed releases', () => {
    const release = { tag_name: 'v1.13.1', draft: false, prerelease: false };
    expect(() => assertPublishedRelease(release, 'v1.13.1')).not.toThrow();
    expect(() => assertPublishedRelease({ ...release, draft: true }, 'v1.13.1')).toThrow();
    expect(() => assertPublishedRelease({ ...release, prerelease: true }, 'v1.13.1')).toThrow();
    expect(() => assertPublishedRelease(release, 'v1.13.2')).toThrow();
    for (const tag of ['v1.13.2-rc.1', 'desktop-v1.13.2-alpha.1', '1.13.1', 'v01.13.1', 'v1.13.1\n']) {
      expect(() => stableVersion(tag)).toThrow();
    }
    expect(() => buildCask({ version: '1.13.1', armSha256: 'bad', intelSha256: hash('x64') })).toThrow();
  });

  it('preserves newer casks and supports deterministic reruns and same-version rebuilds', () => {
    const dir = installers();
    const cask = caskForRelease('v1.13.1', dir);
    expect(caskForRelease('v1.13.1', dir)).toBe(cask);
    expect(shouldUpdateCask('', 'v1.13.1')).toBe(true);
    expect(shouldUpdateCask(cask, 'v1.13.1')).toBe(true);
    expect(shouldUpdateCask(cask, 'v1.13.0')).toBe(false);
    expect(shouldUpdateCask(cask, 'v1.14.0')).toBe(true);
    expect(shouldUpdateCask(cask, 'v2.0.0')).toBe(true);
    expect(shouldUpdateCask(cask.replace('1.13.1', '1.9.0'), 'v1.10.0')).toBe(true);
    expect(() => shouldUpdateCask('invalid', 'v1.13.1')).toThrow();
  });
});
