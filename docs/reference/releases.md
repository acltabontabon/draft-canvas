# Releases

Maintainer reference for changelog entries, generated release notes and publishing.
For contributing a change, see [Contributing](../../CONTRIBUTING.md).

## Release notes

Write a user-facing change **once**, in `CHANGELOG.md`. Everything that tells someone what changed is
generated from it, filtered to who it's for:

| Generated | From | Covers |
| --- | --- | --- |
| A `vX.Y.Z` GitHub release (web, Docker and desktop together) | `scripts/release-notes.mjs` | Shared, Desktop and Web — everything since the previous `vX.Y.Z`, prereleases included |
| A `desktop-vX.Y.Z-alpha.N` GitHub prerelease | `scripts/release-notes.mjs` | Shared and Desktop, from that section only |
| The desktop app's "Update available" notes (`latest.json`) | `scripts/update-manifest.mjs` | Shared and Desktop |
| About → What's New in the web build | `vite.config.ts` at build time | Shared and Web highlights |
| About → What's New in the desktop build | `vite.config.ts` at build time | Shared and Desktop highlights |

Nothing fetches notes at runtime, and nothing is written twice: the install steps, downloads and
signing caveats around each release body are fixed templates in `release-notes.mjs`, not changelog text.
Stable patch release pages lead with their summary and changes, omit the demo GIF, and collapse the
first-time desktop installation notes. Minor and major releases, and desktop previews, keep the demo.
Stable minor and major releases with marked highlights lead with a headline, demo, direct download
links and feature cards; the complete platform changelog and installation guidance are expandable.
An explicitly promoted patch can put `<!-- launch -->` on its own line under a platform section.
It leads with that patch's fixes, then shows the same minor release's marked highlights as a
clearly labeled series overview; unmarked patches keep their compact notes.

### Where a change goes

Under `## [Unreleased]`, in whichever of these fits — leave out any that would be empty:

```markdown
## [Unreleased]

### Shared
- Changes both apps get: the editor, shapes, export, starters, the canvas itself.

### Desktop
- Only the desktop app: files and project folders, Home, Find a Diagram, the menu bar / tray,
  updates, installers and packaging.

### Web
- Only the web app: browser storage and the Library, the offline app, Pages, the Docker image.
```

Decide by where the change actually runs, not where its code lives. Shared source often behaves on
one platform only (a style for a desktop-only screen, say); code under `src/desktop/` or `src-tauri/`
is always Desktop. `####` sub-headings (Added, Fixed, Changed) are fine inside any of the three; any
other `###` heading beside them is an error.

A version may open with a short headline paragraph followed by an explanatory paragraph. What's New
uses the first paragraph as its summary; a release page with feature cards uses it as the headline.

### Highlights for What's New

What's New shows a handful of a release's bullets, not all of them. Mark the ones worth telling
someone using the app by leading with a **bold title** and ending with `<!-- highlight -->`:

```markdown
- **Rename in place** — from Rename File… on the File menu, without leaving Draft Canvas.
  <!-- highlight -->
```

The marker is invisible on GitHub and dropped from every release body. A release's What's New is its
own highlights plus its prereleases'. A desktop preview shows its own entry — it runs its own version
number — until the release it leads to is written, and then folds into it.

What's New for 1.9.4 and earlier is frozen as it was written, in `src/releases/productReleases.ts`
(`ARCHIVED_RELEASES`). Don't add to it.

### Previewing

```bash
npm run release:notes -- desktop-v1.10.0-alpha.2               # what that desktop prerelease said
npm run release:notes -- v1.11.0 --platform web                # one platform's part of a release
npm run release:notes -- vX.Y.Z --draft                        # a release whose section isn't written yet
npm run release:whats-new -- desktop --draft X.Y.Z             # What's New as the desktop build shows it
```

A missing or duplicated version, a heading that isn't a version, mixed headings, or a highlight
without a title fail loudly, naming what to fix; `tests/changelog.test.ts` runs the real changelog
through those rules on every `npm test`. At release time, the desktop half of a `vX.Y.Z` — and every
`desktop-v…` preview — stops without a dated section for its version. The `vX.Y.Z` GitHub release
itself does not: without a section, it is published with GitHub's generated notes instead. So write
the section before tagging.

## Release workflow

For the maintainer. When preparing a release:

1. Keep `CHANGELOG.md`'s `[Unreleased]` section current as you go, in the shape above, marking the
   highlights you'd want in What's New.
2. Before cutting the release, rename `[Unreleased]` to the version with today's date
   (`## [X.Y.Z] - YYYY-MM-DD`), leave a fresh `## [Unreleased]` above it, and preview the notes.
3. At the end of `CHANGELOG.md`, add a `[X.Y.Z]: …/compare/vPREVIOUS...vX.Y.Z` link and move
   `[Unreleased]` to compare from `vX.Y.Z`; `tests/changelog.test.ts` fails until both are there.
4. Bump the version through the normal release process, then ship. Once `package.json`'s version
   reaches that section, About → What's New shows it on its own — no other wiring needed.

Pushing the `vX.Y.Z` tag does the rest: one version, one GitHub Release, everything in it. Full CI
passes before a draft Release is created. Desktop acceptance, packaging, startup and update-signature
checks then pass before the Release becomes public and installed copies receive the update.
Pages publishes the verified web artifact and Docker publishes its verified multi-platform image
after desktop packaging succeeds. See `.github/workflows/release.yml` for the dependencies.
Desktop-only changes go in the same `CHANGELOG.md` section as everything else, under its `### Desktop`.

The landing page at <https://acltabontabon.com/draft-canvas/> needs nothing from you at release time.
Its desktop download links are built from the root `package.json` version when it is deployed, so
cutting the tag updates them; only a *new* platform — a build for an architecture that has never
shipped before — needs a line added, in `www/index.html` beside the three that are there. A change to
the page's words deploys on its own, on a push to `main` that touches `www/`, without waiting for a
release; that deploy rebuilds the editor from the latest `vX.Y.Z` tag, never from `main`.
[`docs/reference/website.md`](website.md) has the rest.

The Docker Hub page's own description is edited on Docker Hub, under **Repository → Edit**, and is
the one part of a release that cannot be automated: Docker Hub answers the description API with 403
for an access token however it is scoped, and only the account password reaches it, which is not
worth putting in CI. It is written for someone who found the image before they found the project,
so it repeats what the README says rather than linking to it — which also means it does not follow
along on its own. Give it a look when a release changes what the product is.

Draft Canvas for VS Code is retired; its final release is the `extension-v0.2.0` tag, and its source,
changelog and release process live at that tag.

Draft Canvas Desktop (`src-tauri/`) has no version or release of its own: it ships in every `vX.Y.Z`
release above. The one exception is a desktop preview ahead of a release, from a
`desktop-vX.Y.Z-alpha.N` tag: its own prerelease titled "Draft Canvas X.Y.Z-alpha.N", with a dated
`## [X.Y.Z-alpha.N]` section in `CHANGELOG.md`; its `X.Y.Z` may lead `package.json`'s
(`scripts/check-desktop-version.mjs` enforces both). See [Releasing](../guides/desktop.md#releasing),
and [Desktop updates](desktop-updates.md) for the update signing key.
