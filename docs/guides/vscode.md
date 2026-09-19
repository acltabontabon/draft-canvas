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

Copy, cut and paste work between diagrams. Only Draft Canvas
shapes are passed to and from the system clipboard; anything else you copy is left alone.

## What the extension does and doesn't do

It doesn't scan your workspace, read other files, collect telemetry, or send your diagram anywhere.
The file goes from VS Code to the app inside the editor tab and back. The app itself makes no network
requests with your diagram (see [Privacy](../reference/privacy.md#embedded-in-vs-code)).

The extension doesn't bundle the app. It loads it from `https://acltabontabon.com/draft-canvas/`, so
the first open needs a network connection. After that the app's offline cache usually lets it open
without one. If it can't load, the tab says *Draft Canvas couldn't be loaded* and offers **Retry** and
**Open in browser**.

## Known limits

- **VS Code shortcuts don't work while the canvas has focus.** Keys pressed in the canvas go to
  Draft Canvas, so `⌘P`, `⌘⇧P` and `⌘W` do nothing there. `⌘S` is passed through. Click the tab title
  or anywhere outside the canvas first.
- **Diagrams with shapes inside shapes need a current Draft Canvas.** An old copy of the app, such as
  one left in its offline cache, refuses the file and says so instead of dropping what's inside. A
  reload fetches the current app.
- **Canvas background images aren't saved in the file.** They last until the tab closes.
