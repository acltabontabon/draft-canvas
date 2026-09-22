#!/usr/bin/env node
// The body of a GitHub release, from CHANGELOG.md — the one source of truth for what changed (see
// changelog.mjs for how a section says who a change is for).
//
//   node scripts/release-notes.mjs <tag>                          prints the release body
//   node scripts/release-notes.mjs <tag> --platform desktop|web   previews one platform's notes
//   node scripts/release-notes.mjs v1.10.0 --draft                previews a release with no section yet
//
// A `vX.Y.Z` tag is a Draft Canvas release: the web app, the Docker image and the desktop app, one
// version, one GitHub release. Its body leads with the demo and the ways to get it, then every change
// since the last release (Web and desktop, Desktop, Web), then how to open the desktop installers the
// first time. A `desktop-vX.Y.Z-alpha.N` tag is a desktop preview ahead of the release it leads to:
// it leads with the desktop reel, lists only what reaches the desktop app, and has no "Get it"
// (there's nothing yet to `docker run` or open on the web).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangelogError, REPO, parseChangelog, releaseNotes, unwrap, versionFromTag, withDraft } from './changelog.mjs';

export { unwrap };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A version's section of the changelog, whole and without its heading; null when there is none. */
export function changelogSection(changelog, version) {
  const entry = parseChangelog(changelog).find((candidate) => candidate.version === version);
  if (!entry) return null;
  const lines = changelog.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index >= entry.line && line.startsWith('## '));
  return lines
    .slice(entry.line, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

export function getIt(version) {
  return [
    '### Get it',
    '',
    '- **On the web:** [acltabontabon.com/draft-canvas](https://acltabontabon.com/draft-canvas/). Nothing you draw leaves your browser.',
    `- **Desktop (macOS and Windows):** the installers under **Assets** below. Installed copies update themselves.`,
    `- **Docker:** \`docker run -d -p 8080:80 acltabontabon/draft-canvas:${version}\``,
    '- **VS Code:** [Draft Canvas for VS Code](https://marketplace.visualstudio.com/items?itemName=acltabontabon.draft-canvas), on its own release schedule.',
  ].join('\n');
}

/** The web app's own ways in, for a preview of the web notes alone. */
export function getItOnTheWeb(version) {
  return [
    '### Get it',
    '',
    '- **On the web:** [acltabontabon.com/draft-canvas](https://acltabontabon.com/draft-canvas/). Nothing you draw leaves your browser.',
    `- **Docker:** \`docker run -d -p 8080:80 acltabontabon/draft-canvas:${version}\``,
  ].join('\n');
}

export const FIRST_LAUNCH = [
  '### Opening the desktop app the first time',
  '',
  'The desktop installers are not signed or notarized, so your OS warns you the first time. They are built by this repository’s release workflow from the tagged source, and `SHA256SUMS.txt` lists their checksums.',
  '',
  '- **macOS:** open the .dmg and drag Draft Canvas to Applications. On first launch macOS says it can’t verify the app: open **System Settings → Privacy & Security**, scroll to the message about Draft Canvas and choose **Open Anyway**. Or, once, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Draft Canvas.app"`.',
  '- **Windows:** run the installer. If SmartScreen says it protected your PC, choose **More info → Run anyway**. It installs for your user only and needs no administrator rights.',
].join('\n');

const demo = (tag, file, alt) => `![${alt}](https://raw.githubusercontent.com/${REPO}/${tag}/docs/media/${file})`;

/**
 * The whole body for a tag, or throws when the changelog has nothing for it. `platform` defaults to
 * what the tag publishes: a desktop preview's notes are the desktop app's; a release's are everyone's.
 */
export function releaseBody(tag, changelog, { platform } = {}) {
  const { version, desktopPreview } = versionFromTag(tag);
  const audience = platform ?? (desktopPreview ? 'desktop' : 'all');
  const notes = unwrap(releaseNotes(changelog, { version, platform: audience, tag }));
  const parts =
    audience === 'desktop'
      ? [demo(tag, 'desktop-demo.gif', 'Draft Canvas Desktop demo'), notes, FIRST_LAUNCH]
      : audience === 'web'
        ? // A desktop preview never reaches the web or Docker, so there's nothing to "get" there yet.
          [demo(tag, 'demo.gif', 'Draft Canvas demo'), ...(desktopPreview ? [] : [getItOnTheWeb(version)]), notes]
        : [demo(tag, 'demo.gif', 'Draft Canvas demo'), getIt(version), notes, FIRST_LAUNCH];
  return `${parts.join('\n\n')}\n`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const tag = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--platform');
  const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : undefined;
  if (!tag) {
    console.error('Usage: release-notes.mjs <tag> [--platform desktop|web|all] [--draft]');
    process.exit(1);
  }
  try {
    let changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    // A preview only: the release workflows never pass it, so a real release still needs its section.
    if (args.includes('--draft')) changelog = withDraft(changelog, versionFromTag(tag).version);
    process.stdout.write(releaseBody(tag, changelog, { platform }));
  } catch (error) {
    console.error(`::error::${error instanceof ChangelogError ? error.message : error}`);
    process.exit(1);
  }
}
