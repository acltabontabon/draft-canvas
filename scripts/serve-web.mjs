#!/usr/bin/env node
/*
 * Serves the staged build the way it is hosted, one port per origin:
 *
 *   :PORT     the site        (draftcanvas.dev, Cloudflare)
 *   :PORT+1   the editor      (app.draftcanvas.dev, Cloudflare)
 *   :PORT+2   the old address (acltabontabon.com, GitHub Pages) — the moved-house page at /draft-canvas/
 *
 * `vite preview` is close, but not close enough to be worth trusting for this: it answers a
 * directory without its trailing slash with a 404, where both hosts redirect to the slash form.
 * That matters because every build here uses a relative `base` — a page served at /draft-canvas
 * would resolve ./assets/* against the origin root and every asset would 404. And on the old
 * address a missing path gets 404.html, which is what forwards old links to the new domain.
 *
 * (Checked against the sibling project site: https://acltabontabon.com/scuttle redirects to
 * /scuttle/ and renders. Pages has always done this.)
 *
 * Run through `npm run site:preview`, which builds, assembles and stages first.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const staged = join(dirname(fileURLToPath(import.meta.url)), '..', '.preview-web');
const port = Number(process.argv[2] ?? 4174);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
};

if (!existsSync(staged)) {
  console.error('serve-web: .preview-web is missing — run `npm run site:preview`.');
  process.exit(1);
}

/** One static host. `notFound` is the page a missing path gets, as each real host does it. */
function serve(root, notFound) {
  return createServer((request, response) => {
    let path;
    try {
      path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    } catch {
      // A stray `%` is a bad request, not a reason for the server to exit.
      response.writeHead(400).end('bad request');
      return;
    }
    // No climbing out of the staged tree, however the path is spelled.
    if (path.includes('..')) {
      response.writeHead(403).end('forbidden');
      return;
    }

    let file = join(root, path);
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) {
        response.writeHead(301, { location: `${path}/` }).end();
        return;
      }
      file = join(file, 'index.html');
    }

    if (!existsSync(file) || statSync(file).isDirectory()) {
      // Never the app shell: falling back to index.html would hide exactly the broken-link failures
      // this preview exists to surface.
      const page = notFound && join(root, notFound);
      if (page && existsSync(page)) {
        response.writeHead(404, { 'content-type': TYPES['.html'] });
        createReadStream(page).pipe(response);
      } else {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('404');
      }
      return;
    }

    // The hosts answer byte ranges, which is what lets a video seek: so does this.
    const size = statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const headers = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(response);
  });
}

serve(join(staged, 'site'), '404.html').listen(port);
serve(join(staged, 'app'), null).listen(port + 1);
serve(join(staged, 'legacy'), 'draft-canvas/404.html').listen(port + 2, () => {
  console.log(`serve-web: site    http://localhost:${port}/`);
  console.log(`serve-web: editor  http://localhost:${port + 1}/`);
  console.log(`serve-web: old     http://localhost:${port + 2}/draft-canvas/  (editor at /draft-canvas/editor/)`);
});
