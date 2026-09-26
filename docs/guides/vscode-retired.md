# Draft Canvas for VS Code has been retired

Draft Canvas for VS Code was an extension that opened `.draftcanvas` files in the hosted editor,
inside an editor tab. Its last release is **0.2.0**, which does nothing but say so. Draft Canvas
continues as the [web editor](https://acltabontabon.com/draft-canvas/editor/) and the
[desktop app](https://github.com/acltabontabon/draft-canvas/releases/latest).

## Your diagrams are unchanged

A `.draftcanvas` file is plain JSON, and the extension never stored anything anywhere else: no
extension storage, no hidden copies, no format of its own. Every file it saved opens as it is:

- **In the desktop app.** Open the file, or add its folder as a project. The desktop app saves back to
  the same file, so a diagram can keep living in your repository next to the code it describes — see
  [Draft Canvas Desktop](desktop.md).
- **In the web editor.** Choose **Import** in the Library and pick the file. **Export → Document →
  Editable** writes it back as a `.draftcanvas` file whenever you want it in the repository again.

Two things to know:

- **Unsaved edits.** If VS Code was holding unsaved changes to a diagram in a tab (its hot exit), they
  are in VS Code's own backup, not in the extension: open the file with the text editor and save.
- **Background images.** The extension kept a canvas background image beside the diagram
  (`name.draftcanvas.background.png` or `.jpg`, `.webp`, `.gif`). Neither the web editor nor the desktop
  app reads that companion file; set the image again there if you want it.

## What the last version does

With 0.2.0 installed, a `.draftcanvas` file opens as text by default. **Open With → Draft Canvas**
shows a page that says what happened, with **Reopen as text**; it loads nothing from the network and
never writes to the file. **Draft Canvas: Where did Draft Canvas go?** in the Command Palette shows the
same notice. Uninstall the extension to have `.draftcanvas` files open as text with nothing in between.

An older copy that was never updated (0.1.0 to 0.1.7) still frames the hosted editor's address. That
address now shows the same notice instead of the editor, so nothing sits on a spinner.

## Why

Draft Canvas is a small, local-first tool made by one person. The extension framed the hosted web
editor rather than bundling it, so it needed a network connection to open anything, its own release
lane and Marketplace upload, and a message protocol kept compatible with every copy ever installed.
What it did that the browser could not — keep a diagram as a file next to the code — the desktop app
does without any of that. Web and desktop are the two platforms Draft Canvas can keep excellent, and
this is the cost of keeping them so.

The extension's source, changelog and release notes stay in the repository's history, at the
`extension-v0.2.0` tag.
