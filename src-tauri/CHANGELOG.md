# Changelog: Draft Canvas Desktop

The desktop app has no version of its own: it is the web app's version (`package.json`), released from a
`desktop-vX.Y.Z` tag. A prerelease (`desktop-v1.10.0-alpha.1`) may lead it: the desktop app's alphas come before
the version it ships in. This file holds only what is specific to the desktop app; the editor's own changes are in
the [main changelog](../CHANGELOG.md).

## [Unreleased]

## [1.10.0-alpha.1] - 2026-09-22

The first alpha of Draft Canvas Desktop: the same canvas as the web app, in its own window, a click away in your
menu bar, with your diagrams as ordinary files on your disk. It's early — expect rough edges, and please tell us
about them.

### Start drawing in a second

- **Quick Draft** (`⌘N` / `Ctrl+N`, or from the menu bar) opens a blank canvas with nothing to name or choose.
  It's kept on your computer as you draw, and offered back if the app closes before you save it.
- **Home is itself a diagram**: New Quick Draft at its centre, a connector running to your unsaved drafts,
  recent files, open project or the starters — each drawn as the diagram it is, so you know "the checkout one"
  before you open it.
- **The menu bar icon opens a small panel**: New Quick Draft, your drafts and recent files as silhouettes, and
  the other ways in. On Windows, right-click the tray icon for the same things as a plain menu. The icon wears a
  dot while a draft is unsaved.

### Your diagrams are files

- **Open, Save and Save As** work with `.draftcanvas` files, and so do drag and drop, recent files, and
  double-clicking a file in Finder or Explorer.
- **Open a folder as a project** to see every diagram in it, drawn, and add new ones beside them.
- **Saving can't damage a file**: each save is written to a temporary file first and swapped in, and a file
  changed by something else is never overwritten without asking.
- **Nothing unsaved is lost**: quitting, restarting and updating all keep it first, and a file with changes asks
  before it closes.

### Stays out of your way

- **Closing the window keeps Draft Canvas in the menu bar or tray**, so the next diagram is instant. Quit really
  quits, and Settings lets you choose.
- **Updates itself, only when you say so**: it looks for a newer version once a day (you can turn that off),
  shows a small notice when there is one, and downloads and restarts only when you choose. Every download is
  checked against a signature built into the app before it can be installed.
- **Private by design**: it never looks through your disk, never uploads what you draw, and touches only the
  files and folders you choose.

### Good to know

- For macOS on Apple Silicon and Windows (x64).
- The installers aren't signed with a paid certificate, so your OS asks once before opening it — see below.
- This alpha updates to later alphas and then to the first stable release on its own.
