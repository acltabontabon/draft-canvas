#!/usr/bin/env node
// The body of a GitHub release, from CHANGELOG.md — the one source of truth for what changed.
//
//   node scripts/release-notes.mjs <tag>           prints the release body
//
// A `vX.Y.Z` tag is a Draft Canvas release: the web app, the Docker image and the desktop app, one
// version. Its body leads with the demo and the ways to get it, then the version's changelog section,
// then how to open the desktop installers the first time. A `desktop-vX.Y.Z-alpha.N` tag is a desktop
// preview ahead of the release it leads to, so it has only the section and the first-launch steps.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'acltabontabon/draft-canvas';

/** A version's section of the changelog, without its heading; null when there is none. */
export function changelogSection(changelog, version) {
  const out = [];
  let found = false;
  for (const line of changelog.split(/\r?\n/)) {
    if (line.startsWith('## [')) {
      if (found) break;
      found = line.startsWith(`## [${version}]`);
      continue;
    }
    if (found) out.push(line);
  }
  return found ? out.join('\n').trim() : null;
}

/**
 * The changelog is hard-wrapped for reading as a file, but a release body is rendered like a comment,
 * where a single newline is a hard break. Re-join each paragraph's and each bullet's wrapped lines.
 */
export function unwrap(markdown) {
  const out = [];
  let open = null;
  const flush = () => {
    if (open !== null) out.push(open);
    open = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush();
      out.push('');
    } else if (line.startsWith('#') || /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line) || line.startsWith('|') || line.startsWith('```')) {
      flush();
      open = line;
    } else if (open === null) {
      open = line;
    } else {
      open = `${open} ${line.trim()}`;
    }
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

export const FIRST_LAUNCH = [
  '### Opening the desktop app the first time',
  '',
  'The desktop installers are not signed or notarized, so your OS warns you the first time. They are built by this repository’s release workflow from the tagged source, and `SHA256SUMS.txt` lists their checksums.',
  '',
  '- **macOS:** open the .dmg and drag Draft Canvas to Applications. On first launch macOS says it can’t verify the app: open **System Settings → Privacy & Security**, scroll to the message about Draft Canvas and choose **Open Anyway**. Or, once, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Draft Canvas.app"`.',
  '- **Windows:** run the installer. If SmartScreen says it protected your PC, choose **More info → Run anyway**. It installs for your user only and needs no administrator rights.',
].join('\n');

/** The whole body for a tag, or throws when the changelog has nothing for it. */
export function releaseBody(tag, changelog) {
  const desktopPreview = tag.startsWith('desktop-v');
  const version = tag.replace(/^desktop-v|^v/, '');
  const section = changelogSection(changelog, version);
  if (!section) throw new Error(`CHANGELOG.md has no "## [${version}]" section.`);
  const parts = desktopPreview
    ? [unwrap(section), FIRST_LAUNCH]
    : [`![Draft Canvas demo](https://raw.githubusercontent.com/${REPO}/${tag}/docs/media/demo.gif)`, getIt(version), unwrap(section), FIRST_LAUNCH];
  return `${parts.join('\n\n')}\n`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [tag] = process.argv.slice(2);
  if (!tag) {
    console.error('Usage: release-notes.mjs <tag>');
    process.exit(1);
  }
  try {
    process.stdout.write(releaseBody(tag, readFileSync(join(root, 'CHANGELOG.md'), 'utf8')));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
