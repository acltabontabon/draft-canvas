# Draft Canvas Desktop

Draft Canvas Desktop is the same editor in a window of its own, made for the moment a meeting needs a
diagram: click Draft Canvas in the menu bar or system tray, start a Quick Draft, and draw. What you draw is
kept on your computer, and when you're done it is a `.draftcanvas` file wherever you choose to put it.

Nothing about it needs an account, a server or a network connection. It is one of three ways to use
Draft Canvas, and all three work on the same file: the [web app](getting-started.md), the
[VS Code extension](vscode.md), and this. It is a preview, for macOS on Apple Silicon and Windows on x64.

## Quick Draft

**New Quick Draft** is in the tray menu, the File menu (`⌘N` / `Ctrl+N`) and on Home. It opens a blank
canvas at once: there is no name to pick, no folder to choose, nothing to set up.

A Quick Draft has no file yet. Until you save it, Draft Canvas keeps a working copy in its own data folder,
so closing the window, quitting, or a crash doesn't lose it. It shows up under **Unsaved** on Home until you:

- **Save** it (`⌘S`), which asks where the file goes, or **Move into Project…** to put it in the folder you have open;
- **Discard** it, from Home; or
- **Export** it, as an image or any other format, like any diagram.

A Quick Draft you never drew on leaves nothing behind. One you did is never deleted for you.

## Files

A diagram is a `.draftcanvas` file, like any other file on your computer.

- **Open** (`⌘O`), drag a file onto the window, pick one from **Recent**, or double-click it in Finder or
  Explorer. If Draft Canvas is already running, the file opens in the running app.
- **Save** (`⌘S`) writes the file. Draft Canvas never saves a file you chose behind your back: the status bar says
  *Unsaved changes* until you do, and asks before closing something unsaved. **Save As…** is `⌘⇧S`.
  **Revert to Saved…** puts back what is on disk.
- **New canvas…** (`⌘⇧N`) asks where the file goes first, then opens it blank.
- The window title is the file's name, and **Reveal in Finder** / **File Explorer** shows where it is.

Saving is careful. The diagram is written to a temporary file next to the original and swapped in only once it
is complete, so an interrupted save can't leave a half-written diagram. If something else changed the file
since you opened it, Draft Canvas asks before replacing it. If it can't save, it says why in plain words
(read-only, disk full, no permission) and your work stays on screen.

Unsaved changes to a file are also copied to the data folder as you work, so if the app closes before you save,
Home offers them back the next time. The file itself isn't touched until you save.

## Folders as projects

A project is a folder. **Open Project…** shows the diagrams in it, subfolders included, and opening one is
opening the file. There is nothing to import and no project file: the folder is the project.

```text
payments/
├── overview.draftcanvas
├── payment-flow.draftcanvas
└── docs/
    └── reconciliation.draftcanvas
```

Home lists names and dates only, and never opens a diagram to draw its row, so a large folder is as quick as a
small one. It skips hidden folders and the usual build folders (`node_modules`, `target`, `dist`), stops at a
depth and a count that a project never reaches, and says so if a folder holds more than it lists.

Because they're plain files, the same diagrams can live in a repository beside the code they describe:

```text
my-service/
├── src/
├── README.md
└── docs/
    ├── architecture.draftcanvas
    └── deployment.draftcanvas
```

They open in Draft Canvas Desktop, open in [VS Code](vscode.md), show up in a pull request, and move and copy like
any other file. Desktop adds nothing to the file: what it writes is byte for byte what the web app's
**Export → Document** writes. The one companion is a background image, kept beside the file the way the VS Code
extension keeps it.

Diagrams you made in the browser aren't shared with the desktop app. Move one over with **Export → Document →
Editable** in the browser, and open the file. Encrypted `.dcenc` exports can't be opened in the desktop app yet:
open those in the browser version. (The desktop app can still create them, from **Export**.)

## The menu bar and system tray

Draft Canvas stays a click away. On macOS it has a menu-bar icon, on Windows a system-tray icon:

- **New Quick Draft**, **New Canvas…**
- **Recent**: the last few files
- **Open File…**, **Open Project…**
- **Show Draft Canvas**, **Settings…**, **Quit**

Closing the window hides it rather than quitting, so the next Quick Draft is instant. The first time, Draft Canvas
tells you where it went and asks whether that's what you want; **Settings** changes it later. **Quit** (from the
menu, `⌘Q`) really quits. Logging out or shutting down never waits on Draft Canvas: anything unsaved is already
kept.

While hidden, Draft Canvas does nothing. It doesn't watch your keyboard, mouse, screen, meetings or other apps,
doesn't look through your disk for diagrams, and doesn't use the network. It only ever touches the files and
folders you choose, and its own data folder.

## Keyboard

Everything in the editor works as it does everywhere else in Draft Canvas ([the shortcuts](keyboard-and-commands.md)).
The desktop adds the file shortcuts, in the menu as well:

| Shortcut | Does |
| --- | --- |
| `⌘N` / `Ctrl+N` | New Quick Draft |
| `⌘⇧N` / `Ctrl+Shift+N` | New canvas… |
| `⌘O` / `Ctrl+O` | Open… |
| `⌘⇧O` / `Ctrl+Shift+O` | Open Project… |
| `⌘S` / `Ctrl+S` | Save |
| `⌘⇧S` / `Ctrl+Shift+S` | Save As… |
| `⌘W` / `Ctrl+W` | Close the window (it stays in the menu bar or tray) |
| `⌘,` / `Ctrl+,` | Settings |
| `⌘Q` / `Ctrl+Q` | Quit |

## Building it yourself

You need Node 22.14 or later, the [Rust toolchain](https://www.rust-lang.org/tools/install), and Tauri's
[system prerequisites](https://v2.tauri.app/start/prerequisites/): Xcode Command Line Tools on macOS, and the
Microsoft C++ Build Tools with WebView2 on Windows.

```bash
npm ci
npm run desktop:dev      # the app, with hot reload
npm run desktop:build    # an installer, in src-tauri/target/release/bundle/
npm run desktop:check    # the desktop build, the Rust checks, and the version check
```

`npm run check` and `npm run e2e` are still the checks for the editor itself, and don't need Rust. The desktop
screens have their own browser tests (`npm run e2e:desktop`), which run the real editor against a faked shell.

How it fits together is in [Architecture](../reference/architecture.md#desktop): the editor is the same React
code as the web app, and the Rust side (`src-tauri/`) does only what a web page can't, which is windows, the
tray, native dialogs and safe file writes.

## Releasing

Desktop releases come from a `desktop-vX.Y.Z` tag, where `X.Y.Z` is the version in `package.json`: the desktop app
has no version of its own, so it can't drift from the web app's. `.github/workflows/desktop-release.yml` verifies
that, builds the macOS (Apple Silicon) `.dmg` and the Windows (x64) installer, and publishes them, with a
checksum file and a build attestation, as a prerelease on the repository's Releases page.

The installers are **not signed or notarized**: that needs paid developer certificates. The operating system
therefore warns the first time, and the release notes say how to continue:

- **macOS:** open **System Settings → Privacy & Security** and choose **Open Anyway** for Draft Canvas.
- **Windows:** in SmartScreen, choose **More info → Run anyway**. The installer is per-user and needs no
  administrator rights.

Signing can be added later without changing anything else; there is deliberately nothing about it in the workflow
today. There is no automatic updater yet either: a new version is a new download.
