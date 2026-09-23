import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChangelog, releaseNotes, versionFromTag, whatsNew } from '../scripts/changelog.mjs';
import { releaseBody } from '../scripts/release-notes.mjs';
import { desktopNotes } from '../scripts/update-manifest.mjs';
import { compareVersions } from '../src/lib/semver';
import { ARCHIVED_RELEASES, PRODUCT_RELEASES } from '../src/releases/productReleases';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * One cycle as it'd really be written: a desktop preview, then the release it leads to, over a
 * release written before the Shared/Desktop/Web split.
 */
const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.10.0] - 2026-10-01',
  '',
  'Draft Canvas on your desktop.',
  '',
  '### Shared',
  '',
  '- **Framed on open** — a diagram opens zoomed to fit, [as described](docs/guides/depth.md). <!-- highlight -->',
  '',
  '### Web',
  '',
  '#### Fixed',
  '',
  '- The offline app no longer serves a stale shell',
  '  after a deploy.',
  '',
  '## [1.10.0-alpha.2] - 2026-09-22',
  '',
  '### Shared',
  '',
  '- The editor eases in.',
  '',
  '### Desktop',
  '',
  '- **Rename in place** — from the File menu. <!-- highlight -->',
  '',
  '## [1.10.0-alpha.1] - 2026-09-21',
  '',
  '### Desktop',
  '',
  '- **Quick Draft** from the menu bar, its marker',
  '  on a line of its own.',
  '  <!-- highlight -->',
  '- Another desktop change.',
  '',
  '## [1.9.4] - 2026-09-20',
  '',
  '### Fixed',
  '',
  '- An older fix, for everyone.',
  '',
  '## [1.1.0] - 2026-09-13',
  '',
  '### Added',
  '',
  '- Something from 1.1.0.',
  '',
].join('\n');

const notes = (version: string, platform: 'desktop' | 'web' | 'all', tag = `v${version}`) => releaseNotes(CHANGELOG, { version, platform, tag });

describe('release notes are the changelog, filtered by platform', () => {
  it('lists a shared change in both platforms’ notes', () => {
    expect(notes('1.10.0-alpha.2', 'desktop')).toContain('The editor eases in.');
    expect(notes('1.10.0-alpha.2', 'web')).toContain('The editor eases in.');
  });

  it('keeps desktop-only changes out of the web notes, and web-only out of the desktop notes', () => {
    const desktop = notes('1.10.0', 'desktop');
    const web = notes('1.10.0', 'web');
    expect(desktop).toContain('Rename in place');
    expect(web).not.toContain('Rename in place');
    expect(web).not.toContain('Quick Draft');
    expect(web).toContain('stale shell');
    expect(desktop).not.toContain('stale shell');
  });

  it('a combined release has every section, each headed for who it is for', () => {
    const all = notes('1.10.0', 'all');
    expect(all.indexOf('### Web and desktop')).toBeLessThan(all.indexOf('### Desktop'));
    expect(all.indexOf('### Desktop')).toBeLessThan(all.indexOf('### Web\n'));
  });

  it('a release folds in the prereleases that led to it, since the web app never shipped them', () => {
    const web = notes('1.10.0', 'web');
    expect(web).toContain('Framed on open');
    expect(web).toContain('**From 1.10.0-alpha.2**');
    expect(web).toContain('The editor eases in.');
    // …but nothing from before the previous release.
    expect(web).not.toContain('An older fix');
  });

  it('a prerelease is only its own section', () => {
    const alpha = notes('1.10.0-alpha.2', 'desktop', 'desktop-v1.10.0-alpha.2');
    expect(alpha).toContain('Rename in place');
    expect(alpha).not.toContain('Quick Draft');
    expect(alpha).not.toContain('Framed on open');
  });

  it('picks the exact version, never one that merely starts the same', () => {
    expect(notes('1.1.0', 'all')).toContain('Something from 1.1.0.');
    expect(notes('1.1.0', 'all')).not.toContain('1.10.0');
  });

  it('links each section it drew on, pinned to the release’s own tag', () => {
    const alpha = notes('1.10.0-alpha.2', 'desktop', 'desktop-v1.10.0-alpha.2');
    expect(alpha).toContain('https://github.com/acltabontabon/draft-canvas/blob/desktop-v1.10.0-alpha.2/CHANGELOG.md#1100-alpha2---2026-09-22');
    const web = notes('1.10.0', 'web');
    expect(web).toContain('[1.10.0](https://github.com/acltabontabon/draft-canvas/blob/v1.10.0/CHANGELOG.md#1100---2026-10-01)');
    // alpha.1 had nothing for the web, so it isn't linked from the web notes.
    expect(web).not.toContain('1100-alpha1');
  });

  it('keeps Markdown links and joins wrapped bullets on the release page', () => {
    const body = releaseBody('v1.10.0', CHANGELOG, { platform: 'web' });
    expect(body).toContain('[as described](docs/guides/depth.md)');
    expect(body).toContain('- The offline app no longer serves a stale shell after a deploy.');
    expect(body).not.toContain('<!-- highlight -->');
    // A marker on its own line leaves no gap behind: still one list, not two.
    const desktop = releaseBody('v1.10.0', CHANGELOG, { platform: 'desktop' });
    expect(desktop).toContain('- **Quick Draft** from the menu bar, its marker on a line of its own.\n- Another desktop change.');
  });

  it('refuses to publish empty notes, and says which section to add', () => {
    expect(() => notes('1.10.0-alpha.1', 'web')).toThrow(/## \[1\.10\.0-alpha\.1\] has nothing for the web app: add a ### Shared or ### Web section/);
  });

  it('fails on a missing, duplicated or mis-headed section instead of guessing', () => {
    expect(() => notes('1.11.0', 'all')).toThrow(/no "## \[1\.11\.0\] - YYYY-MM-DD" section/);
    const twice = `${CHANGELOG}\n## [1.9.4] - 2026-09-20\n\n- Again.\n`;
    expect(() => parseChangelog(twice)).toThrow(/lists ## \[1\.9\.4\] twice \(lines \d+ and \d+\)/);
    const mixed = CHANGELOG.replace('### Web\n\n#### Fixed', '### Web\n\n### Fixed');
    expect(() => parseChangelog(mixed)).toThrow(/mixes "### Shared\/Desktop\/Web" with "### Fixed"/);
    expect(() => parseChangelog('## [soon] - 2026-01-01\n')).toThrow(/"soon" isn't a version/);
  });

  it('reads a tag with or without its v, and a desktop preview tag', () => {
    expect(versionFromTag('v1.10.0')).toEqual({ version: '1.10.0', desktopPreview: false });
    expect(versionFromTag('1.10.0')).toEqual({ version: '1.10.0', desktopPreview: false });
    expect(versionFromTag('desktop-v1.10.0-alpha.2')).toEqual({ version: '1.10.0-alpha.2', desktopPreview: true });
    expect(() => versionFromTag('release-7')).toThrow(/not a release tag/);
  });

  it('defaults to what the tag publishes: a desktop preview’s notes, or everyone’s', () => {
    const preview = releaseBody('desktop-v1.10.0-alpha.2', CHANGELOG);
    expect(preview).toMatch(/^!\[Draft Canvas Desktop demo\]/);
    expect(preview).toContain('### Opening the desktop app the first time');
    expect(preview).not.toContain('### Get it');
    const release = releaseBody('v1.10.0', CHANGELOG);
    expect(release).toContain('### Get it');
    expect(release).toContain('Rename in place');
    expect(release).toContain('stale shell');
  });

  it('tells an installed desktop copy only what reached the desktop — or says there was nothing', () => {
    expect(desktopNotes(CHANGELOG, '1.10.0', 'v1.10.0')).not.toContain('stale shell');
    const webOnly = CHANGELOG.replace('## [1.9.4]', '## [1.9.5] - 2026-09-20\n\n### Web\n\n- Web only.\n\n## [1.9.4]');
    expect(desktopNotes(webOnly, '1.9.5', 'v1.9.5')).toMatch(/^Nothing desktop-specific in this release\. Full changelog: \[1\.9\.5\]\(/);
  });
});

describe('What’s New is the changelog’s marked highlights, for this platform', () => {
  it('shows a shared highlight on both platforms and a desktop one only on desktop', () => {
    const [desktop] = whatsNew(CHANGELOG, 'desktop');
    const [web] = whatsNew(CHANGELOG, 'web');
    expect(desktop!.highlights.map((h) => h.title)).toEqual(['Framed on open', 'Rename in place', 'Quick Draft']);
    expect(web!.highlights.map((h) => h.title)).toEqual(['Framed on open']);
  });

  it('is one entry per release, prereleases folded in, with its summary, date and changelog link', () => {
    const releases = whatsNew(CHANGELOG, 'desktop');
    expect(releases.map((release) => release.version)).toEqual(['1.10.0']);
    expect(releases[0]).toMatchObject({
      date: '2026-10-01',
      summary: 'Draft Canvas on your desktop.',
      changelogUrl: 'https://github.com/acltabontabon/draft-canvas/blob/v1.10.0/CHANGELOG.md#1100---2026-10-01',
    });
  });

  it('shows words, not Markdown', () => {
    const [release] = whatsNew(CHANGELOG, 'web');
    expect(release!.highlights[0]).toEqual({ title: 'Framed on open', description: 'A diagram opens zoomed to fit, as described.' });
  });

  it('insists a highlight has a bold title to show', () => {
    const untitled = CHANGELOG.replace('- **Rename in place** — from the File menu.', '- Rename in place, from the File menu.');
    expect(() => whatsNew(untitled, 'desktop')).toThrow(/## \[1\.10\.0-alpha\.2\]: a <!-- highlight --> bullet needs a \*\*bold title\*\* first/);
  });
});

describe('the real changelog and release configuration', () => {
  const changelog = read('CHANGELOG.md');

  it('parses, and every version’s notes can be generated', () => {
    for (const entry of parseChangelog(changelog)) {
      const tag = entry.version.startsWith('1.10.0-') ? `desktop-v${entry.version}` : `v${entry.version}`;
      expect(() => releaseBody(tag, changelog), entry.version).not.toThrow();
    }
  });

  // The bracketed headings are reference links; without a definition they render as literal
  // "[1.11.0]" on GitHub. They went four releases stale before this check existed.
  it('links every version heading, and [Unreleased] compares from the newest release', () => {
    const defined = new Set([...changelog.matchAll(/^\[([^\]]+)\]: https:\/\/github\.com\//gm)].map((match) => match[1]));
    const versions = parseChangelog(changelog).map((entry) => entry.version);
    const missing = versions.filter((version) => !defined.has(version));
    expect(missing, `add a "[X.Y.Z]: https://github.com/acltabontabon/draft-canvas/compare/…" line to the end of CHANGELOG.md for: ${missing.join(', ')}`).toEqual([]);
    const newest = versions.find((version) => !version.includes('-'));
    expect(changelog).toContain(`[Unreleased]: https://github.com/acltabontabon/draft-canvas/compare/v${newest}...main`);
  });

  it('1.10.0-alpha.2’s desktop notes carry its shared and desktop changes, and its web notes no desktop ones', () => {
    const desktop = releaseBody('desktop-v1.10.0-alpha.2', changelog);
    const web = releaseBody('desktop-v1.10.0-alpha.2', changelog, { platform: 'web' });
    expect(desktop).toContain('Diagrams open framed to fit');
    expect(desktop).toContain('Rename in place');
    expect(web).toContain('Diagrams open framed to fit');
    expect(web).not.toContain('Rename in place');
    expect(web).not.toContain('Find a diagram');
  });

  it('What’s New never shows the same version twice, and the frozen archive stops at 1.9.4', () => {
    const versions = PRODUCT_RELEASES.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(ARCHIVED_RELEASES.every((release) => compareVersions(release.version, '1.9.4') <= 0)).toBe(true);
    expect(PRODUCT_RELEASES.every((release) => release.changelogUrl?.startsWith(`https://github.com/acltabontabon/draft-canvas/blob/v${release.version}/CHANGELOG.md#`))).toBe(true);
  });

  it('keeps the release workflows’ tags, prerelease flags, titles and assets as they were', () => {
    const release = read('.github/workflows/release.yml');
    expect(release).toContain(`- 'v[0-9]+.[0-9]+.[0-9]+'`);
    expect(release).toContain('node scripts/release-notes.mjs "$GITHUB_REF_NAME"');
    expect(release).toContain("prerelease: ${{ contains(github.ref_name, '-') }}");
    const desktop = read('.github/workflows/desktop-release.yml');
    expect(desktop).toContain(`- 'desktop-v[0-9]+.[0-9]+.[0-9]+-*'`);
    expect(desktop).toContain('node scripts/release-notes.mjs "$TAG" > notes.md');
    expect(desktop).toContain('--draft --prerelease --verify-tag');
    expect(desktop).toContain('--title "Draft Canvas $VERSION"');
    expect(desktop).toContain('--draft=false --prerelease --latest=false');
    expect(desktop).toContain('installer: Draft-Canvas_VERSION_macOS_arm64.dmg');
    expect(desktop).toContain('installer: Draft-Canvas_VERSION_Windows_x64.exe');
  });
});
