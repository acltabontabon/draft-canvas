/*
 * The documentation, as pages on the site.
 *
 *   docs/index.md                  ->  /draft-canvas/docs/
 *   docs/guides/<name>.md          ->  /draft-canvas/docs/<name>/
 *   docs/reference/privacy.md      ->  /draft-canvas/docs/privacy/
 *
 * The Markdown in docs/ stays the one copy anybody edits: it still reads on GitHub, and
 * tests/docs.test.ts still checks its links there. This only renders it, at build time, into plain
 * HTML that shares the landing page's stylesheet. The pages ship no script at all, so the site's
 * `connect-src 'none'` policy holds for them without a single hash.
 *
 * Only what someone *using* Draft Canvas reads is published: every guide, and the two reference
 * documents a user lands on from one. The rest of docs/reference/ explains the code to the people
 * changing it, and a link to it goes to GitHub, where the code is.
 *
 * Every link is checked while it is rewritten. A page, a `#section` or an image that is not there
 * fails the build, because on a static site a broken link fails silently, and only for a reader.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { Marked } from 'marked';

export const SITE = 'https://acltabontabon.com/draft-canvas/';
const GITHUB = 'https://github.com/acltabontabon/draft-canvas/blob/main/';

/** The reference documents a user reaches from a guide. Published if present, linked to GitHub if not. */
const PUBLISHED_REFERENCE = ['reference/privacy.md', 'reference/agent-integration.md'];

const escape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * GitHub's heading-to-anchor rule, the same one tests/docs.test.ts checks the docs' links against.
 * The ids have to agree with it, or a `#section` link that works on GitHub lands at the top here.
 */
function slugOf(heading) {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Plain text of inline Markdown, for titles, descriptions and the table of contents. */
function plain(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A PNG's size, from its header, so a screenshot reserves its space before it arrives. */
function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Every page the site publishes, keyed by its path inside docs/. */
function collect(docsDir) {
  const sources = ['index.md'];
  const guides = join(docsDir, 'guides');
  if (existsSync(guides)) {
    sources.push(...readdirSync(guides).filter((f) => f.endsWith('.md')).sort().map((f) => `guides/${f}`));
  }
  sources.push(...PUBLISHED_REFERENCE.filter((source) => existsSync(join(docsDir, source))));

  const pages = new Map();
  const slugs = new Map();
  for (const source of sources) {
    const slug = source === 'index.md' ? '' : posix.basename(source, '.md');
    if (slugs.has(slug)) throw new Error(`docs: ${source} and ${slugs.get(slug)} would both be /docs/${slug}/`);
    slugs.set(slug, source);
    const markdown = readFileSync(join(docsDir, source), 'utf8');
    pages.set(source, { source, slug, markdown, anchors: anchorsOf(markdown) });
  }
  return pages;
}

function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = [];
  const prose = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  for (const [, depth, heading] of prose.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    const base = slugOf(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.push({ id: n === 0 ? base : `${base}-${n}`, depth: depth.length, text: plain(heading) });
  }
  return anchors;
}

/**
 * The sidebar: the guides and reference documents docs/index.md lists in its tables, in its order
 * and under its own names for them. A published page the index only mentions in passing (the VS Code
 * notice) is still a page, just not a destination in the sidebar.
 */
function navigationOf(pages) {
  const index = pages.get('index.md');
  const guides = [];
  const reference = [];
  const seen = new Set();
  for (const [, cell] of index.markdown.matchAll(/^\|\s*(.+?)\s*\|/gm)) {
    const link = cell.match(/^\[([^\]]+)\]\(([^)#\s]+)\)$/);
    if (!link) continue;
    const page = pages.get(posix.normalize(link[2]));
    if (!page || seen.has(page.source)) continue;
    seen.add(page.source);
    (page.source.startsWith('guides/') ? guides : reference).push({ page, title: plain(link[1]) });
  }
  return [
    { heading: 'Guides', items: guides },
    { heading: 'Reference', items: reference },
  ].filter((group) => group.items.length);
}

/** Where page `to` is, written relative to page `from`. Every page is a directory with an index.html. */
function pageHref(from, to) {
  const up = from.slug ? '../' : '';
  return `${up}${to.slug ? `${to.slug}/` : ''}` || './';
}

function rootOf(page) {
  return page.slug ? '../../' : '../';
}

/**
 * Renders every page. `stylesheet` is the site's stylesheet as seen from the site root (the hashed
 * build output, or /src/styles.css under the dev server); `policy` turns a page into its CSP.
 *
 * Returns the pages as { 'docs/<slug>/index.html': html } and the media they use as
 * { 'docs/media/...': absolute path on disk }.
 */
export function renderDocs({ docsDir, repoDir, stylesheet, version, policy = () => '' }) {
  const pages = collect(docsDir);
  const navigation = navigationOf(pages);
  const order = navigation.flatMap((group) => group.items);
  const files = {};
  const media = {};
  const broken = [];

  for (const page of pages.values()) {
    const resolve = (href) => {
      // The site's own pages, written out in full so they work on GitHub too, stay on whichever
      // copy of the site this is: production, the subpath preview, or the dev server.
      if (href.startsWith(SITE)) return { href: rootOf(page) + href.slice(SITE.length) };
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return { href, external: true };
      const [path, anchor] = href.split('#');
      const hash = anchor ? `#${anchor}` : '';
      if (!path) {
        if (anchor && !page.anchors.some((a) => a.id === anchor)) broken.push(`${page.source} → #${anchor}`);
        return { href };
      }
      const target = posix.normalize(posix.join(posix.dirname(page.source), path));
      const published = pages.get(target);
      if (published) {
        if (anchor && !published.anchors.some((a) => a.id === anchor)) broken.push(`${page.source} → ${href}`);
        return { href: pageHref(page, published) + hash };
      }
      if (target.startsWith('media/')) {
        const file = join(docsDir, target);
        if (!existsSync(file)) broken.push(`${page.source} → ${href} (no such file)`);
        media[`docs/${target}`] = file;
        return { href: `${page.slug ? '../' : ''}${target}`, file };
      }
      // Anything else lives in the repository: a contributor document, the README, a source file.
      const repoPath = posix.normalize(posix.join('docs', target));
      if (!existsSync(join(repoDir, repoPath))) broken.push(`${page.source} → ${href} (no such file)`);
      return { href: `${GITHUB}${repoPath}${hash}`, external: true };
    };

    const seen = new Map();
    const marked = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth, text }) {
          const base = slugOf(text);
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          const id = n === 0 ? base : `${base}-${n}`;
          const inner = this.parser.parseInline(tokens);
          if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
          return `<h${depth} id="${id}">${inner}<a class="doc-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
        },
        link({ href, title, tokens }) {
          const target = resolve(href);
          const attrs = title ? ` title="${escape(title)}"` : '';
          return `<a href="${escape(target.href)}"${attrs}>${this.parser.parseInline(tokens)}</a>`;
        },
        image({ href, text, title }) {
          const target = resolve(href);
          const size = target.file && existsSync(target.file) && target.file.endsWith('.png') ? pngSize(target.file) : null;
          const dims = size ? ` width="${size.width}" height="${size.height}"` : '';
          const attrs = title ? ` title="${escape(title)}"` : '';
          return `<img src="${escape(target.href)}" alt="${escape(text)}"${attrs}${dims} loading="lazy" decoding="async" />`;
        },
        table(token) {
          return `<div class="doc-table">${this.constructor.prototype.table.call(this, token)}</div>\n`;
        },
      },
    });

    const body = marked.parse(page.markdown);
    const h1 = page.anchors.find((a) => a.depth === 1);
    const title = h1?.text ?? 'Draft Canvas';
    const lead = page.markdown.split(/\n\s*\n/).find((block) => /^[A-Za-z*_`[]/.test(block.trim()));
    const description = lead ? plain(lead).slice(0, 180) : title;
    const position = order.findIndex((item) => item.page === page);
    const html = layout({
      page,
      title,
      description,
      body,
      version,
      stylesheet,
      navigation,
      contents: page.anchors.filter((a) => a.depth === 2),
      previous: position > 0 ? order[position - 1] : null,
      next: position >= 0 && position < order.length - 1 ? order[position + 1] : null,
    });
    files[`docs/${page.slug ? `${page.slug}/` : ''}index.html`] = html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy(html)}" />`,
    );
  }

  if (broken.length) {
    throw new Error(`docs: ${broken.length} broken link(s) in the published docs:\n  ${broken.join('\n  ')}`);
  }
  return { files, media };
}

function mark(size) {
  return `<svg class="mark" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">
          <rect x="6" y="8" width="11" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
          <rect x="15" y="18" width="11" height="7" rx="2" fill="none" stroke="var(--ink-ghost)" stroke-width="2" />
          <path d="M11.5 15.5v3.5h4" fill="none" stroke="currentColor" stroke-width="1.6" />
        </svg>`;
}

function navList(page, navigation) {
  return navigation
    .map(
      (group) => `<p class="docs-nav-heading">${escape(group.heading)}</p>
          <ul>
${group.items
  .map(
    (item) =>
      `            <li><a href="${pageHref(page, item.page)}"${item.page === page ? ' aria-current="page"' : ''}>${escape(item.title)}</a></li>`,
  )
  .join('\n')}
          </ul>`,
    )
    .join('\n          ');
}

function layout({ page, title, description, body, version, stylesheet, navigation, contents, previous, next }) {
  const root = rootOf(page);
  const home = page.slug ? '../' : './';
  const url = `${SITE}docs/${page.slug ? `${page.slug}/` : ''}`;
  const fullTitle = page.slug ? `${title} — Draft Canvas docs` : 'Draft Canvas docs';
  const stylesheetHref = stylesheet.startsWith('/') ? stylesheet : `${root}${stylesheet}`;
  const current = navigation.flatMap((g) => g.items).find((item) => item.page === page);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(fullTitle)}</title>
    <meta name="description" content="${escape(description)}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Draft Canvas" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${escape(fullTitle)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:image" content="${SITE}og-image.png" />
    <link rel="icon" href="${root}favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="${root}icon-180.png" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0d11" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f7f8" />
    <link rel="stylesheet" href="${stylesheetHref}" />
  </head>

  <body class="docs">
    <a class="skip" href="#content">Skip to content</a>

    <header class="masthead">
      <a class="wordmark" href="${root}" aria-label="Draft Canvas, home">
        ${mark(24)}
        <span>Draft Canvas</span>
      </a>
      <nav class="masthead-nav" aria-label="Site">
        <a href="${root}#draw">Features</a>
        <a href="${home}" aria-current="${page.slug ? 'true' : 'page'}">Docs</a>
        <a href="${root}#get">Download</a>
      </nav>
      <a class="button button-primary masthead-cta" href="${root}editor/">Open editor</a>
    </header>

    <div class="docs-shell">
      <nav class="docs-nav" aria-label="Documentation">
        <a class="docs-nav-home" href="${home}"${page.slug ? '' : ' aria-current="page"'}>Overview</a>
          ${navList(page, navigation)}
      </nav>

      <details class="docs-nav-compact">
        <summary><span class="docs-nav-current">${escape(current?.title ?? (page.slug ? title : 'Overview'))}</span><span class="docs-nav-toggle">All docs</span></summary>
        <nav aria-label="Documentation">
          <a class="docs-nav-home" href="${home}"${page.slug ? '' : ' aria-current="page"'}>Overview</a>
          ${navList(page, navigation)}
        </nav>
      </details>

      <main id="content" class="doc">
${body}
        <footer class="doc-footer">
${
  previous || next
    ? `          <nav class="doc-pager" aria-label="Next and previous">
            ${previous ? `<a class="doc-prev" href="${pageHref(page, previous.page)}"><small>Previous</small>${escape(previous.title)}</a>` : '<span></span>'}
            ${next ? `<a class="doc-next" href="${pageHref(page, next.page)}"><small>Next</small>${escape(next.title)}</a>` : ''}
          </nav>
`
    : ''
}          <p class="doc-edit"><a href="${GITHUB}docs/${page.source}">Edit this page on GitHub</a></p>
        </footer>
      </main>

${
  contents.length > 2
    ? `      <nav class="doc-contents" aria-label="On this page">
        <p class="docs-nav-heading">On this page</p>
        <ul>
${contents.map((a) => `          <li><a href="#${a.id}">${escape(a.text)}</a></li>`).join('\n')}
        </ul>
      </nav>
`
    : ''
}    </div>

    <footer class="footer">
      <div class="footer-brand">
        ${mark(22)}
        <p><strong>Draft Canvas</strong> <span>${escape(version)} · Apache 2.0</span></p>
      </div>
      <nav class="footer-links" aria-label="Elsewhere">
        <a href="https://github.com/acltabontabon/draft-canvas">Source</a>
        <a href="${home}">Docs</a>
        <a href="https://github.com/acltabontabon/draft-canvas/blob/main/CHANGELOG.md">Changelog</a>
        <a href="https://github.com/acltabontabon/draft-canvas/releases">Releases</a>
        <a href="https://hub.docker.com/r/acltabontabon/draft-canvas">Docker</a>
        <a href="https://acltabontabon.com/">acltabontabon.com</a>
      </nav>
    </footer>
  </body>
</html>
`;
}

/** The repository's docs/ and root, as seen from www/. */
export function docsPaths(wwwDir) {
  const repoDir = dirname(wwwDir);
  return { repoDir, docsDir: join(repoDir, 'docs') };
}
