# Changelog

All notable changes to Draft Canvas for VS Code are documented here.

## [Unreleased]

## [0.1.1] - 2026-09-14

### Fixed

- Saving a diagram made with `Draft Canvas: New Diagram` now suggests a `.draftcanvas` file name
  instead of `.json`, so it opens in Draft Canvas again.
- Links in the About dialog now open in your browser or mail app.

## [0.1.0] - 2026-09-14

### Added

- Open `.draftcanvas` files straight into the Draft Canvas editor, with no home screen in between.
- Save with ⌘S / Ctrl+S, from the canvas or anywhere else. Unsaved changes show on the tab, and
  closing it asks first, like any other file.
- `Draft Canvas: New Diagram` starts an untitled diagram you can save anywhere in your workspace.
- A diagram changed outside the canvas (a git checkout, another editor) updates in place.
- A file that isn't a Draft Canvas diagram says so and is left untouched.
- If Draft Canvas can't be loaded, the tab offers Retry and Open in browser.
