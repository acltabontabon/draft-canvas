/*
 * The documentation, as pages on the site.
 *
 *   docs/index.md                  ->  sidebar and reading order
 *   docs/guides/<name>.md          ->  /draft-canvas/docs/<name>/
 *   docs/reference/privacy.md      ->  /draft-canvas/docs/privacy/
 *
 * The Markdown in docs/ stays the one copy anybody edits: it still reads on GitHub, and
 * tests/docs.test.ts still checks its links there. This only renders it, at build time, into plain
 * HTML that shares the landing page's stylesheet. Search loads a static catalog as a same-origin
 * module, so the site's `connect-src 'none'` policy also holds for search.
 *
 * Guides, references, and project documentation render here. Links to source code and workflow
 * files still go to the repository.
 *
 * Every link is checked while it is rewritten. A page, a `#section` or an image that is not there
 * fails the build, because on a static site a broken link fails silently, and only for a reader.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { Marked } from 'marked';

export const SITE = 'https://draftcanvas.dev/';
const GITHUB = 'https://github.com/acltabontabon/draft-canvas/blob/main/';
export const DOCS_START = 'getting-started/';

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

/** Every page in the public directory, keyed by its path inside docs/. */
function collect(docsDir, index, navigation) {
  const sources = ['index.md', ...navigation.flatMap(({ items }) => items.map(({ source }) => source))];
  const pages = new Map();
  const slugs = new Map();
  for (const source of sources) {
    const slug = source === 'index.md' ? '' : posix.basename(source, '.md').toLowerCase();
    if (slugs.has(slug)) throw new Error(`docs: ${source} and ${slugs.get(slug)} would both be /docs/${slug}/`);
    slugs.set(slug, source);
    const markdown = slug ? readFileSync(join(docsDir, source), 'utf8') : index;
    pages.set(source, { source, slug, markdown, anchors: anchorsOf(markdown) });
  }
  return pages;
}

function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = [];
  const prose = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  const headings = [...prose.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)];
  for (const [index, match] of headings.entries()) {
    const [line, depth, heading] = match;
    const base = slugOf(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const content = plain(prose.slice(match.index + line.length, headings[index + 1]?.index));
    anchors.push({ id: n === 0 ? base : `${base}-${n}`, depth: depth.length, text: plain(heading), content });
  }
  return anchors;
}

/** Use the Markdown directory's headings and links as the sidebar's groups and reading order. */
function navigationOf(index) {
  const marked = new Marked({ gfm: true });
  const groups = [{ heading: '', items: [] }];
  const seen = new Set();
  for (const token of marked.lexer(index)) {
    if (token.type === 'heading' && token.depth > 1) {
      groups.push({ heading: plain(token.text), items: [] });
      continue;
    }
    marked.walkTokens([token], (link) => {
      if (link.type !== 'link') return;
      const source = posix.normalize(link.href.split('#')[0]);
      if (source === 'index.md' || !source.endsWith('.md') || /^[\w+.-]+:|^\//.test(source) || seen.has(source)) return;
      seen.add(source);
      groups.at(-1).items.push({ source, title: plain(link.text) });
    });
  }
  return groups.filter(({ items }) => items.length);
}

function searchCatalog(index, pages, navigation) {
  const names = new Map(navigation.flatMap(({ items }) => items.map(({ page, title }) => [page, title])));
  return Array.from(pages.values()).filter((page) => page.slug).flatMap((page) => {
    const heading = page.anchors.find(({ depth }) => depth === 1);
    const title = names.get(page) ?? heading?.text ?? page.slug;
    const href = pageHref(index, page);
    return page.anchors.filter(({ depth }) => depth <= 3).map(({ id, depth, text, content }) => ({
      href: depth === 1 ? href : `${href}#${id}`,
      title,
      section: depth === 1 ? '' : text,
      content,
    }));
  });
}

function searchBox() {
  return `<div class="doc-search" role="search" hidden>
  <label id="docs-query-label" for="docs-query">Search documentation</label>
  <input id="docs-query" type="search" placeholder="Try ‘export’ or ‘keyboard shortcuts’" autocomplete="off" aria-controls="docs-results" />
</div>
<section id="docs-results" aria-label="Search results" hidden>
  <p role="status"></p>
  <ul class="doc-directory" role="list"></ul>
</section>`;
}

/** Where page `to` is, written relative to page `from`. Every page is a directory with an index.html. */
function pageHref(from, to) {
  const up = from.slug ? '../' : '';
  return `${up}${to.slug ? `${to.slug}/` : DOCS_START}`;
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
export function renderDocs({ docsDir, repoDir, stylesheet, policy = () => '' }) {
  const index = readFileSync(join(docsDir, 'index.md'), 'utf8');
  const directory = navigationOf(index);
  const pages = collect(docsDir, index, directory);
  const navigation = directory.map(({ heading, items }) => ({
    heading,
    items: items.map(({ source, title }) => ({ page: pages.get(source), title })),
  }));
  const order = navigation.flatMap((group) => group.items);
  const files = {};
  const media = {};
  const broken = [];

  for (const page of pages.values()) {
    if (!page.slug) continue;
    const resolve = (href) => {
      // The site's own pages, written out in full so they work on GitHub too, stay on whichever
      // copy of the site this is: production, the subpath preview, or the dev server.
      if (href.startsWith(SITE)) return { href: rootOf(page) + href.slice(SITE.length) };
      const [githubPath, githubAnchor] = href.startsWith(GITHUB) ? href.slice(GITHUB.length).split('#') : [];
      const githubPage = githubPath && pages.get(posix.relative('docs', githubPath));
      if (githubPage) {
        if (githubAnchor && !githubPage.anchors.some((a) => a.id === githubAnchor)) broken.push(`${page.source} → ${href}`);
        return { href: pageHref(page, githubPage) + (githubAnchor ? `#${githubAnchor}` : '') };
      }
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return { href };
      const [path, anchor] = href.split('#');
      const hash = anchor ? `#${anchor}` : '';
      if (!path) {
        if (anchor && !page.anchors.some((a) => a.id === anchor)) broken.push(`${page.source} → #${anchor}`);
        return { href };
      }
      // Normalize from the repository root so root-level documents can link back into docs/.
      const repoPath = posix.normalize(posix.join('docs', posix.dirname(page.source), path));
      const target = posix.relative('docs', repoPath);
      const published = pages.get(target);
      if (published) {
        if (anchor && !published.anchors.some((a) => a.id === anchor)) broken.push(`${page.source} → ${href}`);
        return { href: pageHref(page, published) + hash };
      }
      if (target.startsWith('media/')) {
        const file = join(docsDir, target);
        if (!existsSync(file)) broken.push(`${page.source} → ${href} (no such file)`);
        media[`docs/${target}`] = file;
        return { href: `../${target}`, file };
      }
      // Source files and repository configuration are linked to their original location.
      if (!existsSync(join(repoDir, repoPath))) broken.push(`${page.source} → ${href} (no such file)`);
      return { href: `${GITHUB}${repoPath}${hash}` };
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

    const tokens = marked.lexer(page.markdown);
    const contents = page.anchors.filter((a) => a.depth === 2);
    const body = marked.parser(tokens);
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
      stylesheet,
      navigation,
      contents,
      previous: position > 0 ? order[position - 1] : null,
      next: position >= 0 && position < order.length - 1 ? order[position + 1] : null,
    });
    files[`docs/${page.slug}/index.html`] = html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy(html)}" />`,
    );
  }

  if (broken.length) {
    throw new Error(`docs: ${broken.length} broken link(s) in the published docs:\n  ${broken.join('\n  ')}`);
  }
  files['docs/index.html'] = redirectPage(DOCS_START, 'Getting started', DOCS_START);
  files['docs/security/index.html'] = redirectPage('privacy/', 'Privacy and security', '../privacy/');
  const catalog = searchCatalog(pages.get('index.md'), pages, navigation);
  files['docs-search-data.js'] = `export default ${JSON.stringify(catalog)};\n`;
  return { files, media };
}

function redirectPage(slug, title, href) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0; url=${href}" />
  <link rel="canonical" href="${SITE}docs/${slug}" />
  <title>${title} — Draft Canvas docs</title>
</head>
<body><a href="${href}">${title}</a></body>
</html>
`;
}

function navList(page, navigation) {
  return navigation.map(({ heading, items }) => {
    const links = items.map((item) =>
      `<a href="${pageHref(page, item.page)}"${item.page === page ? ' aria-current="page"' : ''}>${escape(item.title)}</a>`,
    );
    if (!heading || links.length === 1) return links.join('\n');
    const open = items.some((item) => item.page === page) ? ' open' : '';
    return `<details${open}>
  <summary>${escape(heading)}</summary>
  <ul role="list">${links.map((link) => `<li>${link}</li>`).join('')}</ul>
</details>`;
  }).join('\n');
}

function layout({ page, title, description, body, stylesheet, navigation, contents, previous, next }) {
  const root = rootOf(page);
  const url = `${SITE}docs/${page.slug}/`;
  const fullTitle = `${title} — Draft Canvas docs`;
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
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Shopify’s inventory reservation architecture drawn in Draft Canvas." />
    <link rel="icon" href="${root}favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="${root}icon-180.png" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#101217" />
    <link rel="stylesheet" href="${stylesheetHref}" />
  </head>

  <body class="docs">
    <a class="skip" href="#content">Skip to content</a>

    <header class="docs-header">
      <div class="drawing-width docs-header-inner">
        <nav class="docs-brand" aria-label="Site">
          <a class="features-brand" href="${root}" aria-label="Draft Canvas, home"><img src="${root}favicon.svg" width="26" height="26" alt="" /> Draft Canvas</a>
          ${page.slug === 'getting-started' ? '' : `<a class="docs-home-link" href="../${DOCS_START}">Docs</a>`}
        </nav>
        <div class="docs-header-actions">
          <button type="button" class="docs-search-trigger" aria-label="Search documentation" aria-haspopup="dialog" hidden>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4" /><path d="m9.5 9.5 3.5 3.5" /></svg>
            <span>Search</span>
          </button>
          <a class="docs-editor-link" href="https://app.draftcanvas.dev/">Open web editor <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </header>

    <div class="docs-shell">
      <nav class="docs-nav docs-nav-links" aria-label="Documentation">
          ${navList(page, navigation)}
      </nav>

      <details class="docs-nav-compact">
        <summary><span class="docs-nav-current">${escape(current?.title ?? title)}</span><span class="docs-nav-toggle">All docs</span></summary>
        <nav class="docs-nav-links" aria-label="Documentation">
          ${navList(page, navigation)}
        </nav>
      </details>

      <main id="content" class="doc" tabindex="-1">
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
}        </footer>
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

    <footer class="drawing-footer">
      <div class="drawing-width drawing-bar">
        <span>Draft Canvas</span>
        <nav aria-label="Resources">
          <a href="${root}#examples">Architecture examples</a>
          <a href="../privacy/">Privacy and security</a>
          <a href="https://github.com/acltabontabon/draft-canvas">GitHub</a>
          <a href="https://ko-fi.com/aclt_attic">Support</a>
        </nav>
      </div>
    </footer>
    <dialog class="docs-search-dialog" aria-labelledby="docs-query-label">
      <button type="button" class="docs-search-close" aria-label="Close search">×</button>
      ${searchBox()}
    </dialog>
    <script type="module" src="${root}docs-search.js"></script>
  </body>
</html>
`;
}

/** The repository's docs/ and root, as seen from www/. */
export function docsPaths(wwwDir) {
  const repoDir = dirname(wwwDir);
  return { repoDir, docsDir: join(repoDir, 'docs') };
}
