# Changelog

All notable changes to Draft Canvas for VS Code are documented here.

## [Unreleased]

## [0.2.0] - 2026-09-26

The last release. Draft Canvas for VS Code is retired; Draft Canvas continues as the web editor and
the desktop app.

### Changed

- The extension no longer opens the editor. A `.draftcanvas` file opens as text by default; **Open
  With → Draft Canvas** shows a page that says what happened and where the file opens now, with
  **Reopen as text**. It loads nothing from the network and never writes to the file.
- **Draft Canvas: New Diagram** is now **Where did Draft Canvas go?**, and shows the same notice. The
  notice also appears once, on its own, the first time the extension is activated after updating.

### Migration

- Your diagrams are unchanged: a `.draftcanvas` file is plain JSON. Open it in the
  [desktop app](https://github.com/acltabontabon/draft-canvas/releases/latest) (open the file, or add
  its folder as a project) or import it into the
  [web editor](https://acltabontabon.com/draft-canvas/editor/) from the Library.
- Unsaved edits VS Code kept for a tab (hot exit) are in VS Code's own backup: open the file with the
  text editor, and save.
- A canvas background image saved beside a diagram (`name.draftcanvas.background.png` and the like)
  is not read by the web editor or the desktop app; set it again there if you want it.
- Uninstall the extension to have `.draftcanvas` files open as text without this page.

## [0.1.7] - 2026-09-24

### Changed

- Opens the editor at its new address, <https://acltabontabon.com/draft-canvas/editor/>, instead of
  being forwarded there from the old one. Earlier versions keep working without updating — the old
  address sends them on — so this only saves the redirect.
- **Open in Browser** now opens the Draft Canvas home page rather than the editor.

## [0.1.6] - 2026-09-21

### Fixed

- Select All, Copy, Cut, Paste and Undo now work inside the canvas's text fields, and selected text
  in the Learn drawer and dialogs can be copied. On a Mac, Ctrl+A and other Ctrl line-editing keys
  keep doing what they always do.
- ⌘P, ⌘⇧P, ⌘W, ⌘⇧T, ⌘⇧F, ⌘J and ⌘, now reach VS Code from the canvas (Ctrl on Windows and Linux).
- A canvas background image is no longer lost when the tab closes. It's saved beside the diagram as
  `name.draftcanvas.background.png` (or `.jpg`, `.webp`, `.gif`) when you save, follows the diagram
  when you rename it in VS Code, is copied along by Save As, and comes back when you reopen it.
  Reverting the file drops an unsaved background change along with the rest.

## [0.1.5] - 2026-09-19

### Added

- The Marketplace page opens with a short demo of Draft Canvas at work.

### Changed

- The README links to a fuller guide and to Getting started.

## [0.1.4] - 2026-09-17

### Fixed

- The README no longer says copy and paste can't reach the system clipboard — that was fixed in
  0.1.3.

## [0.1.3] - 2026-09-14

### Fixed

- Copying, cutting and pasting shapes with the keyboard works, including between diagrams. Only
  Draft Canvas shapes are shared with the clipboard; nothing else you copy is passed to the app.

## [0.1.2] - 2026-09-14

### Fixed

- Saving right after a quick edit includes that edit.
- A diagram reverted or checked out while you're editing no longer ends up different in the canvas
  and in the file.
- One edit that couldn't be applied no longer stops later edits from reaching the file.
- Reloading Draft Canvas inside the tab right after an edit keeps that edit.

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
