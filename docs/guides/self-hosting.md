# Self-hosting Draft Canvas

The web editor is a static site. It needs no backend or database server.

## Build

Use Node.js 22.14 or later and npm. Check out a stable `vX.Y.Z` tag from the
[repository](https://github.com/acltabontabon/draft-canvas), then run:

```bash
npm ci
npm run build
```

Deploy `dist/`. Use `npm run preview` to inspect it locally.
To include the landing page and docs, run `npm ci --prefix www`, then `npm run build:web`;
deploy `dist-web/`.

## Serve

- Serve at `/` or a subdirectory such as `/editor/`. Preserve the directory structure
  and redirect directory URLs to a trailing slash.
- Return 404 for unknown paths; the editor has no client-side routes.
- Use HTTPS outside localhost for offline caching and clipboard support.
- Send correct JavaScript, CSS and manifest content types. Revalidate `index.html`, `sw.js`
  and the manifest; hashed `assets/` files can use long immutable caching.
- Keep the build's Content-Security-Policy. To prevent framing, add response headers
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.

## Storage and updates

Each browser profile and origin has its own diagrams. Export before changing hosts or clearing
site data; see [saving and sharing](saving-and-sharing.md).

[Live sessions](collaborating.md) work from a self-hosted copy too: they run between browsers, not
through your server. The hosted relay only admits app.draftcanvas.dev and the desktop app, so people
join your copy by direct invite unless you run [your own relay](../reference/website.md#the-collaboration-relay).

Deploy the whole build together. An offline copy may stay on the previous version until its
service worker updates. Save or export current work before accepting a reload.
