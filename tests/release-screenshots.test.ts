import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseBody, releaseScreenshots } from '../scripts/release-notes.mjs';

const directories: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCK0AAAAASUVORK5CYII=', 'base64');
const screenshot = (file = 'nodi.png', platform = 'desktop', alt = 'Nodi explains the architecture.') => ({ file, platform, alt });
const changelog = [
  '# Changelog', '', '## [Unreleased]', '', '## [1.16.0] - 2026-10-24', '',
  'Draw and think together.', '', '### Shared', '', '#### Added', '',
  '- **Collaboration** — draw together live. <!-- highlight -->', '',
  '### Desktop', '', '#### Added', '', '- **Nodi** — ask your agent. <!-- highlight -->',
].join('\n');

function fixture(manifest?: unknown) {
  const mediaDirectory = mkdtempSync(join(tmpdir(), 'draft-canvas-release-media-'));
  directories.push(mediaDirectory);
  const versionDirectory = join(mediaDirectory, 'v1.16.0');
  mkdirSync(versionDirectory);
  for (const file of ['nodi.png', 'collaboration.png', 'web.png']) writeFileSync(join(versionDirectory, file), png);
  const manifestPath = join(versionDirectory, 'screenshots.json');
  if (manifest !== undefined) writeFileSync(manifestPath, JSON.stringify(manifest));
  return { mediaDirectory, versionDirectory, manifestPath };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('versioned release screenshot galleries', () => {
  it('leaves a release without a manifest free of gallery markup', () => {
    const { mediaDirectory } = fixture();
    expect(releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toBe('');
    expect(releaseBody('v1.16.0', changelog, { mediaDirectory })).not.toContain('### In the app');
  });

  it('pins the images and README to the tag and places the gallery between highlights and full notes', () => {
    const { mediaDirectory } = fixture([screenshot(), screenshot('collaboration.png', 'shared')]);
    const body = releaseBody('v1.16.0', changelog, { mediaDirectory });
    expect(body).toContain('https://raw.githubusercontent.com/acltabontabon/draft-canvas/v1.16.0/docs/media/releases/v1.16.0/nodi.png');
    expect(body).toContain('https://github.com/acltabontabon/draft-canvas/blob/v1.16.0/README.md');
    expect(body.indexOf('### In the app')).toBeGreaterThan(body.indexOf('### Key highlights'));
    expect(body.indexOf('### In the app')).toBeLessThan(body.indexOf('<summary>Everything added'));
    expect(body.match(/releases\/v1\.16\.0\/nodi\.png/g)).toHaveLength(1);
  });

  it('keeps shared images in both platform previews and filters platform-specific images', () => {
    const { mediaDirectory } = fixture([screenshot(), screenshot('collaboration.png', 'shared'), screenshot('web.png', 'web')]);
    const desktop = releaseBody('v1.16.0', changelog, { mediaDirectory, platform: 'desktop' });
    const web = releaseBody('v1.16.0', changelog, { mediaDirectory, platform: 'web' });
    expect(desktop).toContain('/nodi.png');
    expect(desktop).toContain('/collaboration.png');
    expect(desktop).not.toContain('/web.png');
    expect(web).not.toContain('/nodi.png');
    expect(web).toContain('/collaboration.png');
    expect(web).toContain('/web.png');
    expect(releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toContain('/web.png');
  });

  it('escapes image descriptions without allowing Markdown or HTML to break the release body', () => {
    const { mediaDirectory } = fixture([screenshot('nodi.png', 'desktop', 'A [choice] <label> & an answer.')]);
    expect(releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toContain('![A \\[choice\\] &lt;label&gt; &amp; an answer.](');
  });

  it.each(['../nodi.png', '/nodi.png', 'folder/nodi.png', 'folder\\nodi.png', 'https://example.com/nodi.png', 'nodi.svg', 'nodi.PNG', '.nodi.png'])('rejects unsafe or unsupported filenames: %s', (file) => {
    const { mediaDirectory } = fixture([screenshot(file)]);
    expect(() => releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toThrow(/lowercase PNG filename/);
  });

  it.each([
    { file: 'nodi.png', alt: 'Nodi', platform: 'other' },
    { file: 'nodi.png', alt: '', platform: 'desktop' },
    { file: 'nodi.png', alt: 'Nodi\nAnother line', platform: 'desktop' },
    { file: 'nodi.png', alt: 'Nodi', platform: 'desktop', url: 'https://example.com' },
    null,
    [],
  ])('rejects malformed entries instead of silently publishing incomplete notes: %j', (entry) => {
    const { mediaDirectory } = fixture([entry]);
    expect(() => releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toThrow(/Release screenshots for v1\.16\.0:/);
  });

  it('rejects malformed JSON and non-array manifests with an actionable error', () => {
    const { mediaDirectory, manifestPath } = fixture({});
    expect(() => releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toThrow(/must contain an array/);
    writeFileSync(manifestPath, '[');
    expect(() => releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toThrow(/must contain valid JSON/);
  });

  it('checks missing images even when their platform is filtered out', () => {
    const { mediaDirectory } = fixture([screenshot('missing.png')]);
    expect(() => releaseScreenshots('v1.16.0', 'web', mediaDirectory)).toThrow(/could not read image "missing.png"/);
  });

  it('rejects duplicate and mislabeled image files', () => {
    const { mediaDirectory, manifestPath, versionDirectory } = fixture([screenshot(), screenshot()]);
    expect(() => releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toThrow(/duplicate image/);
    writeFileSync(manifestPath, JSON.stringify([screenshot()]));
    writeFileSync(join(versionDirectory, 'nodi.png'), 'This is not a PNG.');
    expect(() => releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toThrow(/must be a PNG image/);
  });

  it.skipIf(process.platform === 'win32')('refuses symlinks rather than reading outside the version directory', () => {
    const { mediaDirectory, manifestPath, versionDirectory } = fixture();
    const outside = join(mediaDirectory, 'outside.png');
    writeFileSync(outside, png);
    symlinkSync(outside, join(versionDirectory, 'linked.png'));
    expect(lstatSync(join(versionDirectory, 'linked.png')).isSymbolicLink()).toBe(true);
    writeFileSync(manifestPath, JSON.stringify([screenshot('linked.png')]));
    expect(() => releaseScreenshots('v1.16.0', 'all', mediaDirectory)).toThrow(/must be a regular PNG file/);
    expect(readFileSync(outside)).toEqual(png);
  });
});
