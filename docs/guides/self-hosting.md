# Self-hosting Draft Canvas

Draft Canvas's web editor is a static site. It needs no backend, accounts or database server.
Docker distribution is retired; old images receive no further updates.

## Build

Use Node.js 22.14 or later and npm. Check out the latest stable `vX.Y.Z` tag from the
[repository](https://github.com/acltabontabon/draft-canvas), then run:

```bash
npm ci
npm run build
```

The editor is in `dist/`, including its service worker and third-party license notices.
`npm run preview` is useful for checking a local build; use a static web host for deployment.
If you also want the landing page and documentation, run `npm ci --prefix www` followed by
`npm run build:web` and deploy `dist-web/` instead.

## Serve

Serve the contents of `dist/` at a root URL or a directory such as `/editor/`. Preserve the directory
structure and use a trailing slash for directory URLs: the editor's asset paths are relative.
Redirect `/editor` to `/editor/`. Return 404 for unknown paths rather than rewriting every request
to `index.html`; the editor has no client-side routes.

Use HTTPS for access from other machines. Service workers and several clipboard features need a
secure context; browsers also treat localhost as secure for local previews. Serve JavaScript, CSS
and manifest files with their correct content types. Revalidate `index.html`, `sw.js` and the web
manifest on each request; hashed files in `assets/` can use a long immutable cache lifetime.

Keep the build's Content-Security-Policy intact. A static host can additionally send
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` as response headers to
prevent framing; `frame-ancestors` cannot be enforced through an HTML meta tag.

## Storage and updates

Diagrams stay in each browser's IndexedDB. Serving a shared URL does not share diagrams or create
collaboration: each person has their own local Library. Different origins, including different
ports or HTTP versus HTTPS, have separate storage. Export diagrams before moving to another host
or clearing browser data. See [saving and sharing](saving-and-sharing.md).

Deploy a complete build together when upgrading. The offline app may keep a previously loaded
version until the browser accepts the new service worker. When the editor offers an update,
finish or export your current work before reloading.
