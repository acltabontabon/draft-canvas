#!/usr/bin/env node
// The body of a GitHub release, from CHANGELOG.md — the one source of truth for what changed (see
// changelog.mjs for how a section says who a change is for).
//
//   node scripts/release-notes.mjs <tag>                          prints the release body
//   node scripts/release-notes.mjs <tag> --platform desktop|web   previews one platform's notes
//   node scripts/release-notes.mjs v1.10.0 --draft                previews a release with no section yet
//
// A `vX.Y.Z` tag is a Draft Canvas release: the web app, the Docker image and the desktop app, one
// version, one GitHub release. Minor and major releases lead with the demo and ways to get it;
// stable patches lead with their changes and collapse first-time installation guidance. Stable
// minor/major releases use the changelog's marked highlights as a launch page with direct downloads.
// A patch can opt into that page with <!-- launch -->, keeping its fixes ahead of the series overview.
// A `desktop-vX.Y.Z-alpha.N` tag is a desktop preview ahead of the release it leads to:
// it leads with the desktop reel, lists only what reaches the desktop app, and has no "Get it"
// (there's nothing yet to `docker run` or open on the web).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangelogError, REPO, parseChangelog, parseVersion, releaseNotes, unwrap, versionFromTag, whatsNew, withDraft } from './changelog.mjs';

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
    `- **Docker:** \`docker run -d -p 8080:8080 acltabontabon/draft-canvas:${version}\` (port 8080 inside the container since 1.12)`,
  ].join('\n');
}

/** The web app's own ways in, for a preview of the web notes alone. */
export function getItOnTheWeb(version) {
  return [
    '### Get it',
    '',
    '- **On the web:** [acltabontabon.com/draft-canvas](https://acltabontabon.com/draft-canvas/). Nothing you draw leaves your browser.',
    `- **Docker:** \`docker run -d -p 8080:8080 acltabontabon/draft-canvas:${version}\` (port 8080 inside the container since 1.12)`,
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

const tableText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;');

/** The marked changelog bullets are both the app's news and the release page's feature cards. */
function releaseLandingPage(tag, version, changelog, audience, notes) {
  const releases = whatsNew(changelog, audience);
  const news = releases.find((entry) => entry.version === version);
  if (!news) return null;
  const parsed = parseVersion(version);
  const overview = parsed.patch > 0
    ? releases.find((entry) => entry.version === `${parsed.major}.${parsed.minor}.0`) ?? news
    : news;
  const entry = parseChangelog(changelog).find((candidate) => candidate.version === version);
  const intro = unwrap(entry.intro);
  const [headline, ...description] = intro.split(/\n\s*\n/);
  const assets = `https://github.com/${REPO}/releases/download/${tag}`;
  const cards = overview.highlights.map(({ title, description }) =>
    `**${tableText(title)}**${description ? `<br>${tableText(description)}` : ''}`,
  );
  const rows = [];
  for (let at = 0; at < cards.length; at += 2) rows.push(`| ${cards[at]} | ${cards[at + 1] ?? ''} |`);
  const downloads = [];
  if (audience !== 'desktop') downloads.push('**[Open the web editor →](https://acltabontabon.com/draft-canvas/editor/)**');
  if (audience !== 'web') {
    downloads.push(
      `**[macOS · Apple silicon](${assets}/Draft-Canvas_${version}_macOS_arm64.dmg)**`,
      `**[macOS · Intel](${assets}/Draft-Canvas_${version}_macOS_x64.dmg)**`,
      `**[Windows · x64](${assets}/Draft-Canvas_${version}_Windows_x64.exe)**`,
    );
  }
  const details = intro && notes.startsWith(intro) ? notes.slice(intro.length).trim() : notes;
  const parts = [
    `## ${headline || `Draft Canvas ${version}`}`,
    ...description,
    `### Get it\n\n${downloads.join(' · ')}`,
    'No account. No backend. Diagrams stay on your device.',
    ...(overview !== news ? [`### In this update\n\n${news.highlights.map(({ title, description }) => `**${tableText(title)}** — ${tableText(description ?? '')}`).join('\n\n')}`] : []),
    demo(tag, 'demo.gif', 'Draft Canvas: draw, explain, and share software architecture'),
    `### Key highlights${overview !== news ? ` from ${parsed.major}.${parsed.minor}` : ''}\n\n| | |\n| --- | --- |\n${rows.join('\n')}`,
  ];
  if (audience !== 'desktop') {
    parts.push(`### Run it on your own server\n\n\`\`\`bash\ndocker run -d -p 8080:8080 acltabontabon/draft-canvas:${version}\n\`\`\``);
  }
  parts.push(`<details>\n<summary>Everything added, changed and fixed</summary>\n\n${details}\n\n</details>`);
  if (audience !== 'web') {
    parts.push(
      `[Verify your download with SHA256SUMS.txt](${assets}/SHA256SUMS.txt)`,
      `<details>\n<summary>First-time desktop installation</summary>\n\n${FIRST_LAUNCH}\n\n</details>`,
    );
  }
  parts.push('**[Getting started](https://acltabontabon.com/draft-canvas/docs/getting-started/)** · **[All guides](https://acltabontabon.com/draft-canvas/docs/)**');
  return `${parts.join('\n\n')}\n`;
}

/**
 * The whole body for a tag, or throws when the changelog has nothing for it. `platform` defaults to
 * what the tag publishes: a desktop preview's notes are the desktop app's; a release's are everyone's.
 */
export function releaseBody(tag, changelog, { platform } = {}) {
  const { version, desktopPreview } = versionFromTag(tag);
  const audience = platform ?? (desktopPreview ? 'desktop' : 'all');
  const notes = unwrap(releaseNotes(changelog, { version, platform: audience, tag }));
  const parsed = parseVersion(version);
  const launch = changelogSection(changelog, version)?.includes('<!-- launch -->');
  if (!desktopPreview && (parsed.patch === 0 || launch) && parsed.pre.length === 0) {
    const landing = releaseLandingPage(tag, version, changelog, audience, notes);
    if (landing) return landing;
  }
  // A patch should explain its fixes first; the product demo belongs to larger releases.
  if (!desktopPreview && parsed.patch > 0 && parsed.pre.length === 0) {
    const access = audience === 'desktop' ? [] : [audience === 'web' ? getItOnTheWeb(version) : getIt(version)];
    const installation = audience === 'web' ? [] : [
      `<details>\n<summary>First-time desktop installation</summary>\n\n${FIRST_LAUNCH}\n\n</details>`,
    ];
    return `${[notes, ...access, ...installation].join('\n\n')}\n`;
  }
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
