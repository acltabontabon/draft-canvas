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
- A launch page can include screenshots listed in `docs/media/releases/vX.Y.Z/screenshots.json`: an
  array of `{ "file": "nodi.png", "alt": "What it shows", "platform": "desktop" }`, where platform is
  `shared`, `desktop` or `web` and `file` is a lowercase kebab-case PNG in the same directory. The
  generator validates the images. Without a manifest there is no gallery.

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

## Desktop previews

Tag `desktop-vX.Y.Z-alpha.N` or `-beta.N`, with a dated changelog section. `X.Y.Z` may equal or lead
`package.json`. Notes include Shared and Desktop changes.
