# The website

One verified build serves every address, all hosted on Cloudflare.

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
redirects and 404 pages.

## The landing page

`www/index.html` is a static page in two rooms, plus a download dialog: one screen of words (the
statement, two ways in, and a line naming what the film shows), then the film. Behavior worth knowing before you edit it:

- **What the page names, the film shows.** Each name under the headline (`data-film-jump`, in
  seconds) scrolls to the film and starts it at that moment. **Watch it happen** does the same from
  the start.
- **The film** (`#film`, files in `www/public/film/`) fills the window. It starts by itself when it is
  most of what the visitor can see, pauses when scrolled away, and resumes on return unless the visitor
  paused it. A browser only starts a video with sound after the visitor has pressed something, so it is
  tried with sound and, if refused, started silent with captions and a **Sound on** button. Reduced
  motion never starts it: the poster and a play mark wait. Nothing of it is fetched before it is wanted.
- **Its parts.** The labelled dashes under the film are its parts, as the editor's presentation bar
  shows a flow's steps: they fill as it plays and a press jumps there. Their times are
  `data-film-step` attributes; a re-cut film needs them, the jump links and the captions file updated
  together.
- **The end.** When the film ends the room says so, with **Back to top** (where the ways in are) and
  **Watch again**.
- **The pencil.** It draws the headline underline once, on load.

## The build

- `www/vite.config.js` fills in the root `package.json` version for desktop installer links.
- It generates the CSP with `connect-src 'none'`.
- `scripts/assemble-web.mjs` builds `dist-web/` from `site/` (`www/dist/`), `app/` (`dist/`) and
  `cloudflare/` (Wrangler configs), then checks each part. `dist/` is left unchanged.

## The documentation

The site renders the repository's Markdown under `/docs/`. `/docs/` opens Getting started. Each
article has a search control in its header and a grouped sidebar that opens the current article's
topic. Groups with one page appear as direct links. Longer articles also show an on-page outline.
Narrow screens use an expandable guide menu.

- **Published:** the documents listed in `docs/index.md`. The same headings and links define the
  sidebar groups and reading order. Source code and workflow links point to GitHub.
- **Link checks:** broken document, section and image links fail `npm run site:build`. Anchors
  use GitHub's slug rule, as in `tests/docs.test.ts`.
- **Publishing:** docs ship with the site. A docs-only push waits for the next site deploy or release.

With `npm run site:dev`, refresh `http://localhost:5280/docs/` to see an edit.

## Media

| Command | Regenerates |
| --- | --- |
| `node --input-type=module -e "import { runnerImport } from 'vite'; await runnerImport('./www/scripts/checkout-preview.ts')"` | `www/src/checkout-views.json`: the diagram scenes and attachment previews, from `www/examples/` |
| `npm --prefix www run social` | `og-image.png` and the Apple touch icon |

Outputs are committed, so deploys need no browser. The 1200 × 630 social card uses the Shopify
inventory diagram. Run `social` after changing the headline or that diagram, and check that the
headline stays legible at small preview sizes.

## Deploying

`pages.yml` is the only deploy workflow. It deploys to Cloudflare with Wrangler: relay, `app/`,
`site/`, then the `www.` redirect. The relay and `app/` only for a release or a withdrawal; otherwise
just `site/` and the redirect.

Triggers (all share the `pages` concurrency group):

- **Release:** `release.yml` passes the verified artifact after CI and desktop acceptance.
- **Site change:** `pages-site.yml` calls it on a push to `main` touching `www/`,
  `scripts/assemble-web.mjs` or either deploy workflow. It waits (skips) while `package.json` names a
  version that is not the latest published release; that release's deploy publishes it instead.
- **On demand:** run it from `main` (site only, unless `release-tag` is set).

Off a release tag, `pages.yml` builds the editor from the newest stable `vX.Y.Z` and the site and
docs from the workflow commit. Acceptance tests in Chromium, Firefox and WebKit use the selected
release's offline editor tests and the site's web tests and example fixtures. The relay and the
editor's hosting (`relay*.js`, `relay.jsonc`, `app.jsonc`, `app.headers`) come from the release
wherever it has them. A site-only deploy publishes the site and docs, and a release or withdrawal
also publishes the editor and relay.

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

`app.headers` becomes the editor's `_headers`. It prevents framing with an HTTP CSP
`frame-ancestors 'none'` directive and `X-Frame-Options: DENY` for older browsers. This header policy
adds to the editor's build-generated CSP meta tag; `frame-ancestors` cannot be enforced through a
meta tag. Never set `Cross-Origin-Opener-Policy` there: it breaks the old-address handoff, which uses
`window.opener`.

### Edge TLS policy

The editor is a Worker custom domain, so Cloudflare terminates TLS. The intended zone policy is a
minimum of TLS 1.2 with TLS 1.3 enabled. This is a zone setting managed outside the deploy, and it
applies to every proxied hostname in `draftcanvas.dev`. `node scripts/check-cloudflare-tls.mjs` reads
the zone settings and fails on a mismatch; it needs `CLOUDFLARE_ZONE_ID` and a read-only
`CLOUDFLARE_TLS_API_TOKEN`. It does not apply the policy.

### The collaboration relay

The relay carries a [live session](../guides/collaborating.md)'s knock, offer and answer until the
browsers connect directly.

- **Sees:** encrypted messages, a random 128-bit room id, origins, IP addresses, sizes and timing.
- **Stores:** only the owner claim, a SHA-256 of the secret in the handshake
  (`Sec-WebSocket-Protocol: draft-canvas.relay.v1, host.<secret>`); another host is closed with 4003.
  Each owner connection or departure renews the claim for 12 hours.
  No logging; observability is off in `relay.jsonc`.
- **Limits:** one owner and 32 joining sockets per room, at most 4 from one address (per /64 for
  IPv6); text frames of at most 16,384 characters; 30 messages per 10 seconds per socket, and the
  owner that many for every joining socket, since it answers each (past it the owner's frames are
  dropped, never its socket); 60 new sockets per minute per address. A room closes after 15 idle
  minutes, or 12 hours at most. The owner's reconnect replaces a socket the relay still thinks is open.
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

Draft Canvas first lived at `acltabontabon.com/draft-canvas/`, on GitHub Pages. That address is
retired: nothing is published there, and old links to it no longer forward.

IndexedDB is per origin, so diagrams saved at the old address are invisible to
`app.draftcanvas.dev`.

- **Handoff:** a browser that still has the old editor cached offline can run it. Its **Bring my
  diagrams** opens `app.draftcanvas.dev/#handoff` and sends a Library backup with `postMessage`; both
  sides check the exact origin and window. The app still receives it. Protocol:
  `src/storage/handoff.ts`.
- **Path-independent storage:** database names and the `draft-canvas.` preference prefix never derive
  from the path; `tests/privacy.test.ts` enforces it.
