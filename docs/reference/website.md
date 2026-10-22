# The website

One verified build serves every address. Cloudflare hosts `draftcanvas.dev`; GitHub Pages hosts the
old address.

| URL | What it is | Source |
| --- | --- | --- |
| `draftcanvas.dev/` | Landing page | `www/` |
| `draftcanvas.dev/docs/` | Guides and user-facing reference | `docs/`, rendered by `www/scripts/docs.mjs` |
| `app.draftcanvas.dev/` | The editor | `dist/`, unchanged |
| `www.draftcanvas.dev/` | Redirect to the apex | `www/cloudflare/www.js` |
| `relay.draftcanvas.dev` | Live-collaboration relay ([below](#the-collaboration-relay)) | `www/cloudflare/relay.js` |
| `acltabontabon.com/draft-canvas/` | Change-of-address page; other old paths forward | `www/legacy/` |
| `acltabontabon.com/draft-canvas/editor/` | The editor, kept so old diagrams can move | `dist/`, unchanged |

## The source

`www/` is a separate Vite project (own lockfile, plain JavaScript, one stylesheet) sharing no
dependency with the app.

```bash
npm run site:dev        # site only, :5280, hot reload
npm run build:web       # editor + site, assembled into dist-web/
npm run site:preview    # build:web, then serve each host as deployed (:4174 site, :4175 editor, :4176 old address)
npm run e2e:web         # checks against the assembled artifact
```

Run `site:preview` before shipping: `scripts/serve-web.mjs` mimics the hosts' trailing-slash
redirects and 404 pages.

Shapes in `www/index.html` match `src/nodes/describe.ts`, the accent comes from
`src/styles/tokens.css`, and there are no webfonts.

## The build

- `www/vite.config.js` replaces `__VERSION__` with the root `package.json` version for download links.
- It generates the CSP, hashing the one inline script, with `connect-src 'none'`.
- `scripts/assemble-web.mjs` builds `dist-web/` from `site/` (`www/dist/`), `app/` (`dist/`),
  `legacy/` (`www/legacy/` plus `dist/` under `editor/`) and `cloudflare/` (Wrangler configs), then
  checks each part. `dist/` is left unchanged.

## The documentation

`docs/` is the only copy of the docs. The site build renders it under `/docs/`.

- **Published:** `docs/index.md`, every guide, and `PUBLISHED_REFERENCE` in `www/scripts/docs.mjs`
  (privacy and agent integration). Links to anything else go to GitHub.
- **Sidebar:** the rows of the tables in `docs/index.md`, in order. A new guide appears once listed
  there.
- **Link checks:** a link to an unpublished page, anchor or image fails `npm run site:build`. Anchors
  use GitHub's slug rule, as in `tests/docs.test.ts`.
- **Release timing:** pages ship from the release tag, so doc changes go live with the next release.

With `npm run site:dev`, refresh `http://localhost:5280/docs/` to see an edit.

## Media

| Command | Regenerates |
| --- | --- |
| `npm --prefix www run art` | Hero drawing in `www/index.html` (seeded, so repeatable) |
| `npm --prefix www run clips` | The five demo clips in `www/public/clips/`, cut from `docs/media/demo.mp4` with ffmpeg |
| `npx tsx e2e/og-diagram.ts --base <dev server>` | `www/scripts/og-diagram.png`, rendered in the editor from `og-diagram.json` |
| `npm --prefix www run social` | `og-image.png` and the Apple touch icon |

Outputs are committed, so deploys need neither ffmpeg nor a browser. Run `social` after `art`.

## Deploying

`pages.yml` is the only deploy workflow.

1. Cloudflare first, with Wrangler: relay, `app/`, `site/`, then the `www.` redirect.
2. Then `legacy/` to GitHub Pages, only if Cloudflare succeeded.

Triggers (all share the `pages` concurrency group):

- **Release:** `release.yml` passes the verified artifact after CI and desktop acceptance.
- **Site change:** `pages-site.yml` calls it on a push to `main` touching `www/`,
  `scripts/assemble-web.mjs` or either Pages workflow. It waits (skips) while `package.json` names a
  version that is not the latest published release; that release's deploy publishes it instead.
- **On demand:** run it from `main`.

Off a release tag, `pages.yml` builds the newest stable `vX.Y.Z` with this commit's `www/` and
`scripts/assemble-web.mjs` laid over it, and tests it in Chromium, Firefox and WebKit. So the editor
and docs change only on a release.

**Withdrawal:** run `pages.yml` from `main` with `release-tag` set to the last good tag. Follow
[the recovery procedure](reliability.md#withdrawal-and-recovery-procedure) first.

### Cloudflare

Each config in `www/cloudflare/` names its custom domain; `wrangler deploy` creates the DNS record and
certificate. Repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the account holding the `draftcanvas.dev` zone.
- `CLOUDFLARE_API_TOKEN`: limited to that account and zone, with **Account › Workers Scripts › Edit**,
  **Zone › Workers Routes › Edit**, **Zone › DNS › Edit** and **Zone › Zone › Read**.

The relay's Durable Object needs nothing more; its migration in `relay.jsonc` applies on deploy.

Wrangler is pinned in `www/cloudflare/package.json` and its lockfile (`npm ci`, then
`npx --no-install wrangler`). To upgrade, change the version and run `npm install --package-lock-only`
there.

`app.headers` becomes the editor's `_headers`. Never set `Cross-Origin-Opener-Policy` there: it
breaks the old-address handoff, which uses `window.opener`.

### The collaboration relay

The relay carries a [live session](../guides/collaborating.md)'s knock, offer and answer until the
browsers connect directly.

- **Sees:** encrypted messages, a random 128-bit room id, origins, IP addresses, sizes and timing.
- **Stores:** only the owner claim, a SHA-256 of the secret in the handshake
  (`Sec-WebSocket-Protocol: draft-canvas.relay.v1, host.<secret>`); another host is closed with 4003.
  Each owner connection or departure renews the claim for 12 hours.
  No logging; observability is off in `relay.jsonc`.
- **Limits:** one owner and 32 joining sockets per room; text frames with at most 16,384 characters
  of data; 30 messages per 10 seconds per socket; 60 new sockets per minute per address (per /64 for
  IPv6). A room closes after 15 idle minutes, or 12 hours at most.
- **Origins:** only `ALLOWED_ORIGINS`; by default the web editor and the desktop app.

Code:

- `www/cloudflare/relay-room.js`: every rule, no Cloudflare code. Tested by `tests/relay-room.test.ts`.
- `www/cloudflare/relay.js`: the Durable Object adapter.
- `scripts/dev-relay.mjs`: a Node relay for development and e2e (`npm run dev:relay`, port 8791),
  also admitting `http://localhost:*` and `http://127.0.0.1:*`. Tested by `tests/dev-relay.test.ts`.

Builds read `VITE_COLLAB_RELAY` (default `wss://relay.draftcanvas.dev`; `ws://localhost:8791` under
`npm run dev`; empty for none) and add it to the CSP's `connect-src`.

- **Your own relay:** deploy `relay.js` as your own Worker, or anything with the same contract, and
  set `ALLOWED_ORIGINS` to your editor's origin. Build with `VITE_COLLAB_RELAY=wss://…`; see
  [Self-hosting](../guides/self-hosting.md#live-sessions).
- **Desktop:** its CSP is fixed in `src-tauri/tauri.conf.json`; add another relay there too.

### The old address

`acltabontabon.com` belongs to `acltabontabon.github.io`; GitHub serves this project under it at
`/draft-canvas/`. Never give this repository a custom domain: GitHub would redirect the old address,
and its editor, away.

## The move to draftcanvas.dev

IndexedDB is per origin, so diagrams saved at `acltabontabon.com/draft-canvas/editor/` are invisible
to `app.draftcanvas.dev`.

- **Change-of-address page:** `www/legacy/` has no build step. Its `404.html` forwards other old
  paths to the same path on `draftcanvas.dev` (`/editor/…` to the app).
- **Handoff:** the old editor shows **Bring my diagrams**. It opens `app.draftcanvas.dev/#handoff` and
  sends a Library backup with `postMessage`; both sides check the exact origin and window. The new tab
  restores it without overwriting (taken ids arrive as copies). Protocol: `src/storage/handoff.ts`.
  Manual route: **Back up** on the old address, **Restore** on the new.
- **Path-independent storage:** database names and the `draft-canvas.` preference prefix never derive
  from the path; `tests/privacy.test.ts` enforces it. That is why the editor could move to `/editor/`.
- **Old service worker:** `www/legacy/sw.js` replaces the one that served the editor at
  `/draft-canvas/`, deletes only its own caches and unregisters.
