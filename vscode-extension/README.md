# Draft Canvas for VS Code — retired

**This extension is retired, and 0.2.0 is its last release.** Draft Canvas continues as the
[web editor](https://acltabontabon.com/draft-canvas/editor/) and the
[desktop app](https://github.com/acltabontabon/draft-canvas/releases/latest).

Your diagrams are unchanged. A `.draftcanvas` file is plain JSON, and it opens exactly as it is:

- **In the desktop app**: open the file, or add its folder as a project. The desktop app saves back to
  the same file, so a diagram can keep living in your repository.
- **In the web editor**: choose **Import** in the Library and pick the file. **Export → Document**
  writes it back as a `.draftcanvas` file.

Unsaved edits VS Code kept for a tab (hot exit) are in VS Code's own backup: open the file with the
text editor and save. A background image saved beside a diagram (`name.draftcanvas.background.png`) is
not read by the web editor or the desktop app; set it again there if you want it.

## What this version does

With 0.2.0 installed, a `.draftcanvas` file opens as text by default. **Open With → Draft Canvas**
shows a page that says what happened, with **Reopen as text**; it loads nothing from the network and
never writes to the file. **Draft Canvas: Where did Draft Canvas go?** shows the same notice.

To have `.draftcanvas` files open as text with nothing in between, uninstall the extension.

## Why

Draft Canvas is a small, local-first tool made by one person. The extension framed the hosted web
editor rather than bundling it, so it needed a connection and a second release lane, and it did one
thing the desktop app now does better: keep a diagram as a file next to the code it describes. Two
platforms — web and desktop — are what Draft Canvas can keep excellent. The full note is in
[the repository's guide](https://github.com/acltabontabon/draft-canvas/blob/main/docs/guides/vscode-retired.md).
