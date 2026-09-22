// CHANGELOG.md is the one place a user-facing change is written. Everything that tells someone what
// changed — a GitHub release body, the desktop updater's notes, the in-app What's New — is read out of
// it here, filtered to the platform it's for. No dependencies: the release workflows run this with a
// bare `node`, and the app's build (vite.config.ts) runs it for What's New.
//
// A version section says who a change is for with up to three headings, each omitted when empty:
//
//   ## [1.10.0] - 2026-10-01
//   One optional intro paragraph — What's New uses it as the release's summary.
//   ### Shared      both the web app and the desktop app (the editor, export, starters…)
//   ### Desktop     the desktop app only (files, project folders, the menu bar / tray, installers)
//   ### Web         the web app only (browser storage, the offline app, Pages, the Docker image)
//
// `####` sub-headings (Added, Fixed…) are fine inside any of them. A bullet ending in
// `<!-- highlight -->`, and led by a **bold title**, is also shown in What's New. Sections written
// before this format (no Shared/Desktop/Web heading) apply to every platform, as they always did.

// Pure functions only — the app's own bundle imports `headingAnchor` from here. The command lines are
// release-notes.mjs (GitHub release bodies) and whats-new.mjs (What's New, as each build shows it).

export const REPO = 'acltabontabon/draft-canvas';
export const PLATFORMS = ['shared', 'desktop', 'web'];
export const HIGHLIGHT = '<!-- highlight -->';

/** How each part is headed in generated notes. "Shared" is a writer's word; a reader wants who it's for. */
export const LABELS = { shared: 'Web and desktop', desktop: 'Desktop', web: 'Web' };

export class ChangelogError extends Error {}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ? match[4].split('.') : [] };
}

/** Semver precedence: 1.10.0-alpha.1 < 1.10.0-alpha.2 < 1.10.0 < 1.10.1. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new ChangelogError(`Not a version: "${!x ? a : b}".`);
  for (const key of ['major', 'minor', 'patch']) if (x[key] !== y[key]) return x[key] - y[key];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (version) => (parseVersion(version)?.pre.length ?? 0) > 0;

/** `desktop-v1.10.0-alpha.2`, `v1.9.4` or `1.9.4` → its version, and whether it's a desktop preview tag. */
export function versionFromTag(tag) {
  const match = /^(desktop-)?v?(.+)$/.exec(tag.trim());
  if (!match || !parseVersion(match[2])) {
    throw new ChangelogError(`"${tag}" is not a release tag: expected vX.Y.Z, vX.Y.Z-pre or desktop-vX.Y.Z-pre.`);
  }
  return { version: match[2], desktopPreview: Boolean(match[1]) };
}

/** GitHub's own anchor for a heading: lowercased, punctuation dropped, spaces to hyphens. */
export function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** A link to a version's section, pinned to `tag` so it reads the same after the changelog moves on. */
export function changelogUrl(entry, tag) {
  return `https://github.com/${REPO}/blob/${tag}/CHANGELOG.md#${entry.anchor}`;
}

const HEADING = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

/**
 * Every version section, newest first as written. Throws with the line to fix for anything that
 * would otherwise be read wrong: a heading that isn't a version, a version listed twice, or a
 * platform-format section that also has headings outside Shared/Desktop/Web.
 */
export function parseChangelog(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const seen = new Map();
  let current = null;
  const close = () => {
    if (current) entries.push(finishEntry(current));
    current = null;
  };
  lines.forEach((line, index) => {
    if (line.startsWith('## ')) {
      close();
      const match = HEADING.exec(line);
      if (!match) throw new ChangelogError(`CHANGELOG.md line ${index + 1}: "${line}" isn't a "## [X.Y.Z] - YYYY-MM-DD" heading.`);
      const [, version, date] = match;
      if (version === 'Unreleased') return;
      if (!parseVersion(version)) throw new ChangelogError(`CHANGELOG.md line ${index + 1}: "${version}" isn't a version.`);
      if (seen.has(version)) {
        throw new ChangelogError(`CHANGELOG.md lists ## [${version}] twice (lines ${seen.get(version)} and ${index + 1}); merge them.`);
      }
      seen.set(version, index + 1);
      current = { version, date: date ?? null, heading: line.slice(3), line: index + 1, body: [] };
      return;
    }
    current?.body.push(line);
  });
  close();
  return entries;
}

function finishEntry(raw) {
  const intro = [];
  const sections = {};
  const other = [];
  let into = intro;
  for (const line of raw.body) {
    const sub = /^### (.+?)\s*$/.exec(line);
    if (sub) {
      const platform = PLATFORMS.find((name) => name === sub[1].trim().toLowerCase());
      if (platform) {
        if (sections[platform]) throw new ChangelogError(`## [${raw.version}] has two "### ${sub[1]}" sections; merge them.`);
        sections[platform] = [];
        into = sections[platform];
        continue;
      }
      other.push(sub[1]);
    }
    into.push(line);
  }
  const format = Object.keys(sections).length > 0 ? 'platform' : 'legacy';
  if (format === 'platform' && other.length > 0) {
    throw new ChangelogError(
      `## [${raw.version}] mixes "### Shared/Desktop/Web" with "### ${other[0]}". Put every change under one of the three, using #### for sub-groups.`,
    );
  }
  const text = (part) => part.join('\n').trim();
  const trimmed = Object.fromEntries(Object.entries(sections).map(([key, part]) => [key, text(part)]).filter(([, body]) => body));
  return {
    version: raw.version,
    date: raw.date,
    heading: raw.heading,
    anchor: headingAnchor(raw.heading),
    line: raw.line,
    format,
    intro: format === 'platform' ? text(intro) : '',
    // A legacy section is one undivided body, for everyone.
    sections: format === 'platform' ? trimmed : { shared: text(raw.body) },
  };
}

export function findEntry(entries, version) {
  const entry = entries.find((candidate) => candidate.version === version);
  if (!entry) throw new ChangelogError(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section. Add one before releasing.`);
  return entry;
}

/**
 * The sections a release of `version` covers. A prerelease is its own section. A release is every
 * section since the previous release — its own and the prereleases that led to it — because the web
 * app never ships a prerelease: someone on 1.9.4 goes straight to 1.10.0 and has seen none of it.
 */
export function releaseRange(entries, version) {
  const target = findEntry(entries, version);
  if (isPrerelease(version)) return [target];
  const previous = entries
    .filter((entry) => !isPrerelease(entry.version) && compareVersions(entry.version, version) < 0)
    .map((entry) => entry.version)
    .sort(compareVersions)
    .pop();
  return entries
    .filter((entry) => compareVersions(entry.version, version) <= 0 && (!previous || compareVersions(entry.version, previous) > 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The platforms a release body covers. */
export function platformsFor(platform) {
  if (platform === 'all') return PLATFORMS;
  if (platform === 'desktop') return ['shared', 'desktop'];
  if (platform === 'web') return ['shared', 'web'];
  throw new ChangelogError(`Unknown platform "${platform}": use desktop, web or all.`);
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

/** The marker is for What's New only. On a line of its own it takes the line with it, or a bullet splits. */
const dropMarkers = (markdown) =>
  markdown.replace(/\n[ \t]*<!-- highlight -->[ \t]*(?=\n|$)/g, '').replace(/[ \t]*<!-- highlight -->/g, '');
/** Under a `### Desktop` a section's own `###` headings (a legacy body) have to step down a level. */
const demote = (markdown) => markdown.replace(/^### /gm, '#### ');

/**
 * What changed for `platform` in the release of `version`, as Markdown (not yet unwrapped), with a
 * link back to each changelog section it came from. Throws rather than return notes with nothing
 * in them, and names the version and platform that came up empty.
 */
export function releaseNotes(changelog, { version, platform, tag }) {
  const entries = parseChangelog(changelog);
  const wanted = platformsFor(platform);
  // A section written before Shared/Desktop/Web is published exactly as it always was: on its own,
  // for everyone. (Its prereleases were releases of their own then, so nothing is folded into it.)
  const legacy = findEntry(entries, version).format === 'legacy';
  const range = legacy ? [findEntry(entries, version)] : releaseRange(entries, version);
  const [target] = range;
  const folded = range.length > 1;

  const parts = [];
  if (target.intro) parts.push(target.intro);
  let changes = 0;
  if (legacy) {
    // A section written before the format: published exactly as it always was.
    if (target.sections.shared) {
      parts.push(target.sections.shared);
      changes += 1;
    }
  } else {
    for (const part of wanted) {
      const chunks = range.flatMap((entry) => {
        const body = entry.sections[part];
        if (!body) return [];
        const text = entry.format === 'legacy' ? demote(body) : body;
        return [folded && entry !== target ? `**From ${entry.version}**\n\n${text}` : text];
      });
      if (chunks.length === 0) continue;
      changes += chunks.length;
      parts.push(`### ${LABELS[part]}\n\n${chunks.join('\n\n')}`);
    }
  }
  if (changes === 0) {
    const where = wanted.map((part) => `### ${part[0].toUpperCase()}${part.slice(1)}`).join(' or ');
    throw new ChangelogError(`## [${version}] has nothing for ${platform === 'all' ? 'any platform' : `the ${platform} app`}: add a ${where} section.`);
  }

  const links = range
    .filter((entry) => wanted.some((part) => entry.sections[part]))
    .map((entry) => `[${entry.version}](${changelogUrl(entry, tag)})`);
  parts.push(`Full changelog: ${links.join(' · ')}`);
  return dropMarkers(parts.join('\n\n'));
}

/** Markdown down to the words a UI shows: link text, code as text, no emphasis. */
export function plainText(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Each top-level bullet in a body, its wrapped lines joined. */
function bullets(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (/^[-*]\s/.test(line)) out.push(line.replace(/^[-*]\s+/, ''));
    else if (/^\s+\S/.test(line) && out.length > 0 && !/^\s+[-*]\s/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/** A `**Title** — description <!-- highlight -->` bullet, as What's New shows it. */
function highlightOf(bullet, version) {
  const match = /^\*\*(.+?)\*\*\s*[—–:.-]?\s*(.*)$/.exec(bullet.replace(HIGHLIGHT, '').trim());
  if (!match) {
    throw new ChangelogError(`## [${version}]: a ${HIGHLIGHT} bullet needs a **bold title** first — "${bullet.slice(0, 60)}…"`);
  }
  const title = plainText(match[1]).replace(/[.:]$/, '');
  // In the changelog it runs on after the dash; in What's New it's a sentence of its own.
  const rest = plainText(match[2]);
  const description = rest.charAt(0).toUpperCase() + rest.slice(1);
  return description ? { title, description } : { title };
}

/**
 * What's New for `platform`: one entry per release (a release's highlights include its
 * prereleases'), newest first, only for releases that marked something worth telling. Prereleases
 * have no entry of their own — the app only ever runs a release version.
 */
export function whatsNew(changelog, platform) {
  const entries = parseChangelog(changelog);
  const wanted = platformsFor(platform);
  const releases = [];
  for (const entry of entries) {
    if (isPrerelease(entry.version)) continue;
    const range = releaseRange(entries, entry.version);
    const highlights = range.flatMap((part) =>
      wanted.flatMap((key) => bullets(part.sections[key] ?? '').filter((bullet) => bullet.includes(HIGHLIGHT))).map((bullet) => highlightOf(bullet, part.version)),
    );
    if (highlights.length === 0) continue;
    const summary = entry.intro ? plainText(entry.intro.split(/\n\s*\n/)[0]) : '';
    releases.push({
      version: entry.version,
      ...(entry.date ? { date: entry.date } : {}),
      ...(summary ? { summary } : {}),
      highlights,
      changelogUrl: changelogUrl(entry, `v${entry.version}`),
    });
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/** The changelog with an empty, dated `## [version]` section on top, unless it has one — for previews. */
export function withDraft(changelog, version) {
  if (!parseVersion(version)) throw new ChangelogError(`--draft needs a version, not "${version}".`);
  if (parseChangelog(changelog).some((entry) => entry.version === version)) return changelog;
  // A platform heading with nothing under it yet: a new-format section, so its prereleases fold in.
  const heading = `## [${version}] - ${new Date().toISOString().slice(0, 10)}\n\n### Shared\n\n`;
  const at = changelog.search(/^## \[(?!Unreleased\])/m);
  return at === -1 ? `${changelog}\n${heading}` : `${changelog.slice(0, at)}${heading}${changelog.slice(at)}`;
}

