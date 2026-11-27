# The website

How draftcanvas.dev, its docs, the hosted editor and the relay are built and deployed. One verified
build serves every address, all hosted on Cloudflare.

| URL | What it is | Source |
| --- | --- | --- |
| `draftcanvas.dev/` | Landing page | `www/` |
| `draftcanvas.dev/docs/` | Guides and user-facing reference | `docs/`, rendered by `www/scripts/docs.mjs` |
| `app.draftcanvas.dev/` | The editor | `dist/`, unchanged |
| `www.draftcanvas.dev/` | Redirect to the apex | `www/cloudflare/www.js` |
| `relay.draftcanvas.dev` | Live-collaboration relay ([below](#the-collaboration-relay)) | `www/cloudflare/relay.js` |

## The source

`www/` is a separate Vite project (own lockfile, plain JavaScript, one stylesheet) sharing no
dependency with the app.

```bash
npm run site:dev        # site only, :5280, hot reload
npm run build:web       # editor + site, assembled into dist-web/
npm run site:preview    # build:web, then serve each host as deployed (:4174 site, :4175 editor)
npm run e2e:web         # checks against the assembled artifact
```

Run `site:preview` before shipping: `scripts/serve-web.mjs` mimics the hosts' trailing-slash
redirects and 404 pages. `www/vite.config.js` fills in the root `package.json` version for the
desktop installer links and generates the site's CSP with `connect-src 'none'`.

## The landing page

`www/index.html` is a static page: one screen of words, then the film (`www/public/film/`).

- Each name under the headline (`data-film-jump`, in seconds) starts the film at that moment.
- The labelled dashes under the film are its parts (`data-film-step`). A re-cut film needs these
  times, the jump links and the captions file updated together.
- The film is never fetched before it is wanted, and reduced motion never starts it.

## The documentation

- **Published:** the documents listed in `docs/index.md`, whose headings and links also set the
  sidebar groups and reading order. A page's first paragraph, cut to 180 characters, is its
  description. Links to source code, workflows and unpublished files point to GitHub.
- **Link checks:** broken document, section and image links fail `npm run site:build`. Anchors use
  GitHub's slug rule, as in `tests/docs.test.ts`.
- **Publishing:** docs ship with the site. A docs-only push waits for the next site deploy or release.
- **Preview:** with `npm run site:dev`, refresh `http://localhost:5280/docs/` to see an edit.

## Media

| Command | Regenerates |
| --- | --- |
| `node --input-type=module -e "import { runnerImport } from 'vite'; await runnerImport('./www/scripts/checkout-preview.ts')"` | `www/src/checkout-views.json`: the diagram scenes and attachment previews, from `www/examples/` |
| `npm --prefix www run social` | `og-image.png` and the Apple touch icon |

Outputs are committed, so deploys need no browser. Run `social` after changing the headline or the
social card's Shopify inventory diagram, and check that the headline stays legible at small preview
sizes.

## Deploying

`pages.yml` is the only deploy workflow. It deploys with Wrangler in this order: relay, `app/`,
`site/`, then the `www.` redirect. The relay and `app/` deploy only for a release or a withdrawal;
other runs deploy `site/` and the redirect.

All triggers share the `pages` concurrency group:

- **Release:** `release.yml` passes the verified artifact after CI and desktop acceptance.
- **Site change:** `pages-site.yml` calls it on a push to `main` touching `www/`,
  `scripts/assemble-web.mjs` or either deploy workflow. It skips while `package.json` names a version
  that is not the latest published release; that release's deploy publishes the change instead.
- **On demand:** run it from `main` (site only, unless `release-tag` is set). To withdraw a release,
  follow the [withdrawal procedure](releases.md#withdrawal-and-recovery-procedure).

Off a release tag, `pages.yml` builds the editor from the newest stable `vX.Y.Z` and the site and
docs from the workflow commit. Its Chromium, Firefox and WebKit acceptance tests use that release's
offline editor tests with the site's web tests and example fixtures. The relay and the editor's
hosting files (`relay*.js`, `relay.jsonc`, `app.jsonc`, `app.headers`) come from the release wherever
it has them.

### Cloudflare

Each config in `www/cloudflare/` names its custom domain; `wrangler deploy` creates the DNS record and
certificate, and applies the relay's Durable Object migration in `relay.jsonc`. Repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the account holding the `draftcanvas.dev` zone.
- `CLOUDFLARE_API_TOKEN`: limited to that account and zone, with
  **Account › Workers Scripts › Edit**, **Zone › Workers Routes › Edit**, **Zone › DNS › Edit** and
  **Zone › Zone › Read**.

Wrangler is pinned in `www/cloudflare/package.json` and its lockfile (`npm ci`, then
`npx --no-install wrangler`). To upgrade, change the version and run `npm install --package-lock-only`
there.

`app.headers` becomes the editor's `_headers`. It forbids framing with a CSP header
(`frame-ancestors 'none'`, which the build's CSP meta tag cannot enforce) and `X-Frame-Options: DENY`
for older browsers. Never set `Cross-Origin-Opener-Policy` there: it breaks the
[old-address handoff](#the-old-address), which uses `window.opener`.

### Edge TLS policy

The editor is a Worker custom domain, so Cloudflare terminates TLS. The zone should require TLS 1.2
at minimum, with TLS 1.3 enabled. That zone setting is managed outside the deploy and covers every
proxied hostname in `draftcanvas.dev`.

`node scripts/check-cloudflare-tls.mjs` reads the zone settings and fails on a mismatch, without
changing them. It needs `CLOUDFLARE_ZONE_ID` and a read-only `CLOUDFLARE_TLS_API_TOKEN`.

### The collaboration relay

The relay carries a [live session](../guides/collaborating.md)'s knock, offer and answer until the
browsers connect directly.

- **Sees:** encrypted messages, a random 128-bit room id, origins, IP addresses, sizes and timing.
- **Stores:** only the owner claim, a SHA-256 of the secret in the handshake
  (`Sec-WebSocket-Protocol: draft-canvas.relay.v1, host.<secret>`). Another host is closed with 4003.
  Each owner connection or departure renews the claim for 12 hours. Nothing is logged: observability
  is off in `relay.jsonc`.
- **Origins:** only `ALLOWED_ORIGINS`; by default the web editor and the desktop app.
- **Owner reconnects:** replace a socket the relay still thinks is open.

| Limit | Value |
| --- | --- |
| Sockets per room | One owner and 32 joining sockets, at most 4 of them from one address (per /64 for IPv6) |
| Text frames | At most 17,408 characters, or the socket is closed; a message's `data` at most 16,384, or it is dropped as malformed |
| Messages | 30 per 10 seconds per socket; the owner may send that many for every joining socket, since it answers each. Past it, the owner's frames are dropped, never its socket. |
| New sockets | 60 per minute per address |
| Room lifetime | 15 idle minutes, or 12 hours at most |

The rules live in `www/cloudflare/relay-room.js` (no Cloudflare code; `tests/relay-room.test.ts`), and
`relay.js` is the Durable Object adapter. `npm run dev:relay` runs `scripts/dev-relay.mjs`, a Node
relay on port 8791 for development and e2e that also admits `http://localhost:*` and
`http://127.0.0.1:*` (`tests/dev-relay.test.ts`).

Builds read `VITE_COLLAB_RELAY` (default `wss://relay.draftcanvas.dev`; `ws://localhost:8791` under
`npm run dev`; empty for none) and add it to the CSP's `connect-src`.

- **Your own relay:** deploy `relay.js` as your own Worker, or anything with the same contract, and
  set `ALLOWED_ORIGINS` to your editor's origin. Build with `VITE_COLLAB_RELAY=wss://…`; see
  [Self-hosting](../guides/self-hosting.md#live-sessions).
- **Desktop:** its CSP is fixed in `src-tauri/tauri.conf.json`; add another relay there too.

### The old address

The editor's first address, `acltabontabon.com/draft-canvas/` on GitHub Pages, is retired: nothing is
published there and old links don't forward. IndexedDB is per origin, so diagrams saved there are
invisible to `app.draftcanvas.dev`.

- **Handoff:** a browser with the old editor cached offline can still run it. Its **Bring my
  diagrams** opens `app.draftcanvas.dev/#handoff` and sends a Library backup with `postMessage`; both
  sides check the exact origin and window. The app still receives it (`src/storage/handoff.ts`).
- **Path-independent storage:** database names and the `draft-canvas.` preference prefix never derive
  from the path; `tests/privacy.test.ts` enforces it.
