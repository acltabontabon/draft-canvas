# Self-hosting Draft Canvas

The web editor is a static site with no backend.

## Build

With Node.js 22.14 or later, check out a stable `vX.Y.Z` tag of the
[repository](https://github.com/acltabontabon/draft-canvas) and run:

```bash
npm ci
npm run build
```

Deploy `dist/`; `npm run preview` tries it locally. For the landing page and docs too, run
`npm ci --prefix www` and `npm run build:web`, then deploy `dist-web/`.

## Serve

- Serve at `/` or a folder such as `/editor/`, redirecting folder URLs to a trailing slash.
- Return 404 for unknown paths. Send correct JavaScript and CSS content types.
- Use HTTPS (except on localhost) for offline use and the clipboard.
- Revalidate `index.html` and `sw.js`; hashed `assets/` files can be cached forever.
- Keep the build's Content-Security-Policy. To block framing, also send
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` headers.

## Live sessions

[Live sessions](collaborating.md) run between browsers, not through your server.

- The hosted relay accepts only app.draftcanvas.dev and the desktop app, so people join your copy by
  direct invite.
- To use session links, run [your own relay](../reference/website.md#the-collaboration-relay) and
  build with `VITE_COLLAB_RELAY=wss://your-relay npm run build`.
- `VITE_COLLAB_RELAY=` (empty) leaves the relay out.

## Storage and updates

- Diagrams belong to each browser and address. Export before moving hosts or clearing site data; see
  [Saving and sharing](saving-and-sharing.md).
- Deploy each build as a whole. Open copies keep the old version until their service worker updates.
