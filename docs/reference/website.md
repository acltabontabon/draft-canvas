# The website

`https://acltabontabon.com/draft-canvas/` is the landing page, and the editor lives one level below
it at `https://acltabontabon.com/draft-canvas/editor/`. Both come out of one build and deploy as one
artifact.

| URL | What it is | Where it comes from |
| --- | --- | --- |
| `/draft-canvas/` | The landing page | `www/` |
| `/draft-canvas/editor/` | The editor | `dist/`, unchanged |
| `/draft-canvas/docs/` | The guides, and the reference a user reads | `docs/`, rendered by `www/scripts/docs.mjs` |
| `/draft-canvas/sw.js` | A service worker that retires the editor's old registration | `www/public/sw.js` |

## The source

`www/` is a self-contained Vite project: its own `package.json`, its own lockfile, plain JavaScript
and one stylesheet, and no dependency shared with the app. That is deliberate rather than tidy —
`tests/privacy.test.ts` fails the build on a `fetch` anywhere in `src/`, and the site does not live
in `src/`, so the two cannot leak into each other by accident.

```bash
npm run site:dev        # the site alone, on :5280, with hot reload
npm run build:web       # builds the editor, builds the site, assembles dist-web/
npm run site:preview    # the above, staged under /draft-canvas/ and served like GitHub Pages
npm run e2e:web         # the checks that only make sense against the assembled artifact
```

`npm run site:preview` is the one that matters before shipping. It serves the build at the real
subpath through `scripts/serve-web.mjs`, which redirects a directory URL missing its trailing slash
exactly as Pages does — because with a relative `base`, a page served at `/draft-canvas` would
resolve `./assets/*` against the origin root and load nothing at all. A preview that cannot show you
that is a preview that will let it ship.

The page is a drafting sheet: warm paper and ink in a light theme, the same sheet under a lamp in a
dark one, with the product's teal accent from `src/styles/tokens.css`. The shapes drawn in
`www/index.html` follow `src/nodes/describe.ts`: an API carries its socket notch and a Worker its
second card, because that is what they look like in the editor. There are no webfonts, for the same
reason the app has none; the headings use the system serif.

## The build

`vite.config.js` in `www/` does two things worth knowing about:

- **`__VERSION__` becomes the app's version**, read from the root `package.json` at build time. The
  desktop download links are built from it, so cutting a release updates them with nothing to edit.
- **The Content-Security-Policy is generated**, including a SHA-256 hash of the one inline script on
  the page, computed from the bytes that end up in the output. It ships `connect-src 'none'`: the
  page cannot reach any other origin, including github.com.

`scripts/assemble-web.mjs` puts `www/dist/` and `dist/` together into `dist-web/` and then asserts
that what it built is deployable — both entry documents present, the editor's own service worker
inside `editor/`, nothing of the editor's leaked to the root. `dist/` itself is untouched, which is
what lets static self-hosting, the offline e2e suite and the desktop build go on consuming it.

## The documentation

`docs/` is still the one copy of the documentation anybody edits. It reads on GitHub as it always
has, and `tests/docs.test.ts` checks its links there. The site build also renders it into pages under
`/draft-canvas/docs/`, so someone who clicks Docs on the landing page, or Documentation in the app,
reads it on the site instead of in a code repository.

- **What is published.** `docs/index.md`, every guide in `docs/guides/`, and the reference documents
  a user lands on from a guide (`PUBLISHED_REFERENCE` in `www/scripts/docs.mjs`: privacy and agent
  integration). The rest of `docs/reference/` is for people changing the code, so a link to it, or
  to the README, CONTRIBUTING or a source file, goes to GitHub.
- **The sidebar** is the guides and reference that `docs/index.md` lists in its tables, in that order
  and under the names it gives them. A new guide shows up in the sidebar once the index lists it.
- **Links are checked as they are rewritten.** A link to a page, a `#section` or an image that the
  build did not publish fails `npm run site:build`. Heading ids follow GitHub's rule, the same one
  `tests/docs.test.ts` uses, so an anchor that works on GitHub works here too.
- **No script.** The pages are static HTML that share the landing page's stylesheet, under the same
  generated CSP. Navigation on a phone is a plain `<details>`.
- **Which docs ship.** `pages.yml` builds from the release tag, so the docs on the site always
  describe the editor at `/draft-canvas/editor/`. A fix to a guide goes live with the next release,
  not on the push.

`npm run site:dev` renders a page on every request, so an edited guide shows on a refresh at
`http://localhost:5280/docs/`.

## Media

| Command | What it regenerates |
| --- | --- |
| `npm --prefix www run art` | The hero's pencil-and-ink drawing, written into `www/index.html` |
| `npm --prefix www run clips` | The five short demo clips, cut from `docs/media/demo.mp4` with ffmpeg |
| `npm --prefix www run social` | `og-image.png`, from the hero and the stylesheet, and the Apple touch icon |

All three commit their output, so a deploy needs neither ffmpeg nor a browser download. The hero is
seeded, so a re-run draws the same pencil strokes; run `social` after it so the share card matches.
The reel's one still, `www/public/stills/source-evidence.jpg`, is the 1.14.0 release screenshot
`docs/media/releases/v1.14.0/source-evidence.png` at 1600×900.

## Deploying

`pages.yml` is the only workflow that deploys. Release tags start `release.yml`, which completes
reusable CI and desktop acceptance before calling Pages with the verified web artifact. Pages
checks its recorded commit and promotes those same bytes. It also runs on demand and through
`workflow_call`; `pages-site.yml` calls it on a push to `main` that touches `www/`, so a rewritten
sentence does not have to wait for a release. Calls share the `pages` concurrency group.

Site-only publication waits when `package.json` names a version newer than the latest published
stable release. A release-preparation push can update media while the newest available editor is
still the previous version; deploying that combination would reuse the tagged release's Pages
deployment identifier for different contents. The tagged release owns that publication instead.

The editor half only ever changes on a release or an explicit withdrawal. For site-only changes,
`pages.yml` checks out the newest stable `vX.Y.Z`, lays the commit's `www/` and
`scripts/assemble-web.mjs` over it, builds once, and tests that combined artifact in all three
browser engines before publication. Tests use the selected release's documentation and journeys.
So `/draft-canvas/editor/` never serves unreleased code, and download links carry a released version.

For withdrawal, run the current workflow from `main` with `release-tag` naming the last good
editor tag; its revision must belong to the default branch's history and pass verification. Follow
[the compatibility and recovery procedure](reliability.md#withdrawal-and-recovery-procedure) before
putting an older editor in front of documents saved by a newer one.

Nothing about the domain lives in this repository. The apex belongs to `acltabontabon.github.io`, and
GitHub applies a user site's custom domain to every project site of the same account, so the
`/draft-canvas/` prefix comes from the repository name. A `CNAME` file here would try to claim the
apex from the root site.

## How the move was made safe

The editor answered at `/draft-canvas/` for a long time, so moving it had to leave three things
working.

**Saved diagrams.** Nothing was migrated, because nothing needed to be: the IndexedDB databases
(`draft-canvas`, `draft-canvas-keys`) and the `draft-canvas.` preference prefix are plain constants,
so they are per-origin and the path never entered into them. `tests/privacy.test.ts` keeps it that
way — a key built from `location.pathname` or `import.meta.env.BASE_URL` fails the build.

**The old service worker.** It had scope over the whole path and answered *every* navigation under it
with the precached editor shell, so left alone it would go on serving the old app at the landing
page's address. `www/public/sw.js` replaces it at its own URL, skips its own wait, deletes only the
caches whose names contain its scope — which is how Workbox names them and how nothing else on this
shared origin is named — and unregisters itself. It does not claim clients or reload anything: a tab
still running the old editor keeps running it until it navigates. So a returning visitor may see one
stale editor load at `/draft-canvas/` before the worker retires. Their work is autosaved throughout,
and the next visit is the landing page.
