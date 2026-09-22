#!/usr/bin/env node
/*
 * Serves the staged build the way GitHub Pages serves it.
 *
 * `vite preview` is close, but not close enough to be worth trusting for this: it answers
 * /draft-canvas (no trailing slash) with a 404, where Pages answers with a redirect to
 * /draft-canvas/. That difference matters here more than anywhere else in the repo, because both
 * halves of this deploy use a relative `base` — a page served at /draft-canvas would resolve
 * ./assets/* against the origin root and every asset would 404. A preview that cannot show you
 * that is a preview that will let it ship.
 *
 * (Checked against the sibling project site: https://acltabontabon.com/scuttle redirects to
 * /scuttle/ and renders. Pages has always done this, which is why the editor has been fine at
 * /draft-canvas/ all along.)
 *
 * Run through `npm run site:preview`, which builds, assembles and stages first.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.preview-web');
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

if (!existsSync(root)) {
  console.error('serve-web: .preview-web is missing — run `npm run site:preview`.');
  process.exit(1);
}

createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
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
    // Pages answers an unknown path with its 404 page, not with index.html. Falling back to the
    // app shell would hide exactly the broken-link failures this preview exists to surface.
    response.writeHead(404, { 'content-type': 'text/plain' }).end('404');
    return;
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}).listen(port, () => {
  console.log(`serve-web: http://localhost:${port}/draft-canvas/  (editor at /draft-canvas/editor/)`);
});
