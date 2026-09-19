# Draft Canvas for VS Code

Architecture diagrams that live next to your code.

Open a `.draftcanvas` file and you're straight in the [Draft Canvas](https://acltabontabon.com/draft-canvas/)
editor. Draw, hit ⌘S / Ctrl+S, and the diagram is saved back to that file: plain JSON you can diff,
review and commit.

## Usage

- **Open a diagram:** click any `.draftcanvas` file in the Explorer.
- **Start a new one:** run `Draft Canvas: New Diagram` from the Command Palette, draw, then save it
  wherever it belongs (`docs/architecture/payments.draftcanvas`, say).
- **Save:** ⌘S / Ctrl+S, from the canvas or anywhere else. The tab shows unsaved changes like any
  other file, and closing it asks before throwing them away.

Got diagrams in the browser version? Export them there (Export → Document, editable) and drop the
`.draftcanvas` files into your repo.

To see a diagram's raw JSON, right-click its tab and choose **Reopen Editor With… → Text Editor**.

## What this extension does

It opens `.draftcanvas` files in the Draft Canvas web app, inside an editor tab. VS Code reads and
writes the file; the app draws it. That's it.

Shapes you look inside (⌘↓) keep what you draw there in the same `.draftcanvas` file, so one file
still holds the whole picture, from the big one down to the detail.

- It doesn't scan your workspace, read other files or upload your source code.
- It collects no telemetry.
- The file is handed to the app inside VS Code and never sent anywhere. The app itself makes no
  network requests with your diagram.

The app is loaded from `https://acltabontabon.com/draft-canvas/`, so the first open needs a network
connection. After that, the app's offline cache usually lets it open without one.

## Known limits

- **VS Code shortcuts don't work while the canvas has focus.** Keys pressed inside the canvas go to
  Draft Canvas, so ⌘P, ⌘⇧P and ⌘W do nothing there. ⌘S is passed through. Click the tab title or
  anywhere outside the canvas first.
- **A canvas with shapes drawn inside other shapes needs a current Draft Canvas.** An older copy of
  the app, such as one left in its offline cache, won't open it and says so, rather than dropping
  what's inside.
- **Background images aren't saved in the file.** A canvas background image lasts until the tab
  closes.
- Desktop VS Code only, for now. Not available on vscode.dev.

## About Draft Canvas

A diagramming tool for developers, built for the moment in a meeting when someone needs to draw the
architecture instead of just describing it. Services, queues, databases, flows you can present step
by step, and sequence diagrams from those flows. Open source, no account.

## Links

- [Working with `.draftcanvas` files in VS Code](https://github.com/acltabontabon/draft-canvas/blob/main/docs/guides/vscode.md), the longer guide
- [Getting started](https://github.com/acltabontabon/draft-canvas/blob/main/docs/guides/getting-started.md)
- [Draft Canvas](https://acltabontabon.com/draft-canvas/)
- [GitHub](https://github.com/acltabontabon/draft-canvas)
- [Issues](https://github.com/acltabontabon/draft-canvas/issues)
