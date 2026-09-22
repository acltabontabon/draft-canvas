# Changelog: Draft Canvas Desktop

The desktop app has no version of its own: it is the web app's version (`package.json`), released from a
`desktop-vX.Y.Z` tag. This file holds only what is specific to the desktop app; the editor's own changes are in
the [main changelog](../CHANGELOG.md).

## [Unreleased]

### Added

- The first Draft Canvas Desktop preview, for macOS (Apple Silicon) and Windows (x64): the same editor in its own
  window, with `.draftcanvas` files and folders on disk as the documents and projects.
- A Quick Draft: start drawing from the menu bar or system tray with nothing to name or choose. The work is kept on
  your computer until you save it, and offered back if the app closes before then.
- A Home that is itself a diagram: New Quick Draft at its centre, and a row of your unsaved drafts, recent files,
  the open project or the starters, each drawn as the diagram it is.
- Open, Save, Save As, drag and drop, recent files, and double-clicking a `.draftcanvas` file to open it.
- Saves are written to a temporary file first and swapped in, so an interrupted save can't damage the diagram, and
  a file changed by something else is never overwritten without asking.
- The window closes to the menu bar or tray, so it is a click away. Quit really quits.
- The menu bar or tray icon opens a small panel: New Quick Draft, your unsaved drafts and recent files drawn as
  the diagrams they are, and the other ways in.
