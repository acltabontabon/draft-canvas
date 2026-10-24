# Releases

## Release notes

Write user-facing changes only in `CHANGELOG.md`. Release notes, desktop update notes and What's New
are generated from it (`scripts/changelog.mjs`).

- Group changes under `### Shared`, `### Desktop` or `### Web`, then
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories at `####`: Added, Changed,
  Deprecated, Removed, Fixed, Security. Omit empty headings.
- An optional paragraph under the version heading becomes the What's New summary.
- Highlight a bullet with a **bold title** and `<!-- highlight -->`.
- Minor and major releases get a launch-style page; a patch opts in with `<!-- launch -->` on its own
  line in a platform section.
- A launch page can include screenshots from `docs/media/releases/vX.Y.Z/screenshots.json`.
  Add an array of `{ "file": "nodi.png", "alt": "What the screenshot shows", "platform": "desktop" }`
  entries, where platform is `shared`, `desktop` or `web`. Images must be regular PNG files in the
  same directory, with lowercase kebab-case filenames. The generator checks every image and filters
  the gallery for platform previews. No manifest means no gallery; historical releases need no changes.
  Screenshots appear between the highlights and full notes, and their URLs and the README link point
  to the release tag so later edits cannot change a published release's examples.

```markdown
### Shared

#### Changed

- **Clearer connectors** — captions stay visible while editing.
  <!-- highlight -->
```

## Release workflow

1. Rename `[Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add an empty `[Unreleased]` above it.
2. Set `package.json` and `package-lock.json` to `X.Y.Z`.
3. Update the compare links at the end of the changelog:

   ```markdown
   [X.Y.Z]: https://github.com/acltabontabon/draft-canvas/compare/vPREVIOUS...vX.Y.Z
   [Unreleased]: https://github.com/acltabontabon/draft-canvas/compare/vX.Y.Z...main
   ```

4. Preview (add `--draft`, or `--draft X.Y.Z` for What's New, before the dated section exists):

   ```bash
   npm run release:notes -- vX.Y.Z
   npm run release:whats-new -- desktop    # or web
   ```

5. Commit, push, then push the `vX.Y.Z` tag.

The tag runs [release.yml](../../.github/workflows/release.yml): full CI, a draft release, then the
[desktop release](desktop-updates.md#what-a-release-does). After that succeeds, the
[website](website.md) deploys and, for stable tags, [Homebrew](desktop-updates.md#homebrew-releases)
updates.

## Editorial updates after publication

A launch page can be curated as an illustrated tour, with the tagged changelog and README linked
for the complete notes. Keep setup steps and privacy boundaries accurate: distinguish encrypted
peer collaboration from the unencrypted desktop LAN option, and explain the agent provider's access
to diagram context and permitted code. Give informative images descriptive alt text.

Commit new media separately and pin its public URLs to that media commit. Keep the published release
tag and installer assets in place. Preview the Markdown with GitHub's renderer before editing the
published notes with `gh release edit`, then inspect the live page, animations, links and narrow layouts.

For wide screenshot galleries, use a `<picture>` with a phone layout selected by
`<source media="(max-width: 600px)">`. Stack close-ups from the same captures so controls and text
remain readable; link the picture to the full desktop image. Use an appropriately sized animation
for phones too. Verify the rendered page at 320, 390 and 430 pixels, check intermediate widths for
button wrapping, and restore the browser viewport after reviewing.

## Desktop previews

Tag `desktop-vX.Y.Z-alpha.N` or `-beta.N`, with a dated changelog section. `X.Y.Z` may equal or lead
`package.json`. Notes include Shared and Desktop changes.
