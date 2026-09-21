# Working with `.draftcanvas` files in VS Code

The [Draft Canvas extension](https://marketplace.visualstudio.com/items?itemName=acltabontabon.draft-canvas)
opens `.draftcanvas` files in the Draft Canvas editor, inside a VS Code tab. VS Code reads and writes
the file, and the app draws it. That makes a diagram an ordinary file in your repository: it
lives next to the code it describes, and it shows up in a pull request like everything else.

It needs desktop VS Code 1.100 or later. It isn't available on vscode.dev.

## Open, create and save

- **Open a diagram.** Click any `.draftcanvas` file in the Explorer. It opens straight into the
  editor.
- **Start a new one.** Run **Draft Canvas: New Diagram** from the Command Palette. It opens an
  untitled diagram (`Untitled-1.draftcanvas`, then `Untitled-2`, and so on). Draw, then save it
  wherever it belongs, for example `docs/architecture/checkout.draftcanvas`.
- **Save.** `⌘S` / `Ctrl+S`, from the canvas or anywhere else. `⌘⇧S` / `Ctrl+Shift+S` is Save As. The
  tab shows unsaved changes like any other file, and closing it asks before throwing them away.

Panning and zooming aren't edits: moving around a diagram doesn't mark the file as changed.

## How it differs from the browser

The file is the storage. There is no Library and nothing goes into browser storage, so saving works
like any other file in VS Code. The status bar says *This diagram is the open file* in place of
*Saved locally*.

Everything else about drawing is the same: shortcuts, the command palette, flows and presenting,
looking inside shapes, Learn. Shapes you look inside (`⌘↓`) are saved in the same file, so one file
holds the whole picture from overview to detail.

## Diagrams in a repository

- **Diffs are readable.** A `.draftcanvas` file is plain JSON with a fixed field order. Saving an
  unchanged diagram writes identical bytes, so a change to a diagram is a change to the diff.
- **The file follows the repository.** If you switch branches, revert, or undo a change in VS
  Code's own history, the canvas reloads to match.
- **See the raw JSON.** Right-click the tab and choose **Reopen Editor With… → Text Editor**.
  This is also the place to resolve a merge conflict.
- **If the text stops being a valid diagram** (a half-resolved conflict, say), the canvas keeps
  showing its last valid version and writes nothing to the file until the text is fixed. A file that
  was never valid opens with an explanation and is left untouched.
- **Bringing in browser diagrams.** In the browser version, **Export → Document → Editable** saves a
  `.draftcanvas` file. Drop it into your repository. The extension edits `.draftcanvas` files only, so
  an encrypted `.dcenc` export needs the browser version to open it first.

## Copy and paste

Copy, cut and paste work between diagrams, and inside the canvas's text fields (a note, a label, a
search box), along with Select All and Undo there. Shapes and text both go through VS Code's
clipboard. The app asks for the clipboard's text only when you paste into a text field, and never
sends it anywhere.

## What the extension does and doesn't do

It doesn't scan your workspace, read your source code, collect telemetry, or send your diagram
anywhere. The only files it touches are the diagram you open and, if the canvas has a background
image, the image saved beside it. The file goes from VS Code to the app inside the editor tab and back. The app itself makes no network
requests with your diagram (see [Privacy](../reference/privacy.md#embedded-in-vs-code)).

The extension doesn't bundle the app. It loads it from `https://acltabontabon.com/draft-canvas/`, so
the first open needs a network connection. After that the app's offline cache usually lets it open
without one. If it can't load, the tab says *Draft Canvas couldn't be loaded* and offers **Retry** and
**Open in browser**.

## Known limits

- **Only some VS Code shortcuts work while the canvas has focus.** Keys pressed in the canvas go to
  Draft Canvas first. `⌘S`, `⌘P`, `⌘⇧P`, `⌘W`, `⌘⇧T`, `⌘⇧F`, `⌘J` and `⌘,` are passed on to VS Code
  (`Ctrl` on Windows and Linux), using VS Code's default keys rather than any you've changed. Any
  other VS Code shortcut does nothing there: click the tab title or anywhere outside the canvas
  first. Where Draft Canvas has its own shortcut, such as `⌘K`, that one wins.
- **Diagrams with shapes inside shapes need a current Draft Canvas.** An old copy of the app, such as
  one left in its offline cache, refuses the file and says so instead of dropping what's inside. A
  reload fetches the current app.
- **A canvas background image is a second file.** When you save, it's written next to the diagram as
  `name.draftcanvas.background.png` (or `.jpg`, `.webp`, `.gif`), not inside it. Keep the two together:
  renaming the diagram in VS Code moves it along, but moving or copying the diagram anywhere else
  leaves the background behind, and the diagram then opens without one.
