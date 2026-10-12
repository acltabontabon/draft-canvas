# Releases

Changelog format and steps for publishing Draft Canvas.

## Release notes

Write user-facing changes once in `CHANGELOG.md`. GitHub release notes, desktop update notes and
in-app What's New are generated from it.

Under `[Unreleased]`, group changes by where they run. Use only **Shared**, **Desktop** and **Web**
at `###` level, omitting empty groups. Optional `####` headings such as Fixed or Added go inside them.

```markdown
## [Unreleased]

### Shared

- Changes to the shared editor, shapes or exports.

### Desktop

- Changes to native files, projects, tray or installers.

### Web

- Changes to browser storage, offline support or hosting.
```

A version can start with a short headline; its first paragraph becomes the What's New summary.
Mark highlights with a **bold title** and `<!-- highlight -->`:

```markdown
- **Clearer connectors** — captions stay visible while editing.
  <!-- highlight -->
```

A patch can opt into launch-style release notes by placing `<!-- launch -->` on its own line
inside a platform section. Older What's New entries in `ARCHIVED_RELEASES` remain frozen.

## Release workflow

1. Finalize `[Unreleased]` entries and highlights.
2. Rename the section to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh `[Unreleased]` section above it.
3. Update `package.json` and its lockfile to `X.Y.Z`. The desktop takes its version from the root
   package; the stable tag must match it.
4. Add the version's comparison link and update `[Unreleased]` at the end of the changelog:

   ```markdown
   [X.Y.Z]: https://github.com/acltabontabon/draft-canvas/compare/vPREVIOUS...vX.Y.Z
   [Unreleased]: https://github.com/acltabontabon/draft-canvas/compare/vX.Y.Z...HEAD
   ```

5. Preview the generated notes and highlights before tagging:

   ```bash
   npm run release:notes -- vX.Y.Z
   npm run release:whats-new -- desktop
   ```

   Use `web` instead of `desktop` for web highlights. To preview before writing the dated section,
   use `release:notes -- vX.Y.Z --draft` or `release:whats-new -- desktop --draft X.Y.Z` with `npm run`.
6. Commit and push the release changes, then push the `vX.Y.Z` tag.

CI verifies the release, including performance budgets, before creating a draft. Desktop packaging,
startup and update-signature checks gate publication; Pages publishes the verified web artifact
after desktop packaging succeeds.
Homebrew verifies both published macOS installers and updates the cask independently of Pages and
updater channels. See [Homebrew releases](../guides/desktop.md#homebrew-releases) for credentials and retries.
The dependencies are in [release.yml](../../.github/workflows/release.yml).

## Desktop previews

Use `desktop-vX.Y.Z-alpha.N` or `desktop-vX.Y.Z-beta.N` with a matching dated changelog section.
Its base version may equal or lead the root package version. Preview notes include Shared and Desktop;
a stable desktop release ships with the web app under `vX.Y.Z`.

See [Desktop releases](../guides/desktop.md#releasing) for packaging and
[Desktop updates](desktop-updates.md) for signing and update channels.

## Website

Landing-page changes deploy separately; see [Website](website.md).
