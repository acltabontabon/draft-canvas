# Draft Canvas Desktop

Draft Canvas Desktop is the same editor in a window of its own, made for the moment a meeting needs a
diagram: click Draft Canvas in the menu bar or system tray, start a Quick Draft, and draw. What you draw is
kept on your computer, and when you're done it is a `.draftcanvas` file wherever you choose to put it.

Nothing about it needs an account, a server or a network connection. It is one of three ways to use
Draft Canvas, and all three work on the same file: the [web app](getting-started.md), the
[VS Code extension](vscode.md), and this. It is for macOS, on Apple Silicon or Intel, and Windows on x64.

## Quick Draft

**New Quick Draft** is in the tray menu, the File menu (`⌘N` / `Ctrl+N`) and on Home, where it's the big
**Quick Draft** button. It opens a blank canvas at once: there is no name to pick, no folder to choose, nothing
to set up.

A Quick Draft has no file yet. Until you save it, Draft Canvas keeps a working copy in its own data folder,
so closing the window, quitting, or a crash doesn't lose it. It shows up under **Drafts** on Home until you:

- **Save** it (`⌘S`), which asks where the file goes, or **Move into Project…** to put it in your most recent project;
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
- **New File…** (`⌘⇧N`) asks where the file goes first, then opens it blank.
- The window title is the file's name, and **Reveal in Finder** / **File Explorer** shows where it is.
- **Rename File…**, from the File menu or a file's own action in Find a Diagram, changes its name in place —
  no need to leave Draft Canvas, and the diagram's own title is untouched.

Saving is careful. The diagram is written to a temporary file next to the original and swapped in only once it
is complete, so an interrupted save can't leave a half-written diagram. If something else changed the file
since you opened it, Draft Canvas asks before replacing it. If it can't save, it says why in plain words
(read-only, disk full, no permission) and your work stays on screen.

Unsaved changes to a file are also copied to the data folder as you work, so if the app closes before you save,
Home offers them back the next time. The file itself isn't touched until you save.

## Folders as projects

A project is a folder. **Add project…** (`⌘⇧O`) adds one to Home, and it stays there, beside every other project
you've added, until you choose **Remove from Home** (which forgets it and leaves the folder alone). There is
nothing to import and no project file: the folder is the project, and opening a diagram is opening the file.

```text
payments/
├── overview.draftcanvas
├── payment-flow.draftcanvas
└── docs/
    └── reconciliation.draftcanvas
```

Home's **Projects** row shows the ones you used last, each as a small stack of its diagrams with the newest on
top. Choose one to see everything in it, drawn. **Find a diagram** (`⌘F`) searches every project, your recent
files and your drafts at once, by name or folder, and the chips along the top narrow it to one of them. A
project whose folder isn't there right now (on a drive that isn't plugged in, say) stays on the list, marked
as missing, and comes back when the folder does.

Inside a project, subfolders show as tiles of their own — open one to see just what's in it, with breadcrumbs
back up, and **New canvas here** for wherever you are. Searching descends into every folder below the one
you're in; browsing doesn't, so a large project stays a folder at a time rather than one long list.

Home finds a folder's diagrams by name and date alone, so a large folder is as quick as a small one. It skips
hidden folders and the usual build folders (`node_modules`, `target`, `dist`), stops at a depth and a count that
a project never reaches, and says so if a folder holds more than it lists. A project is only listed once
something shows it, so fifty projects cost nothing until you look. Only the files on screen are looked inside,
to draw each one as its diagram: shapes only, never the words, and looking isn't opening, so nothing is added to
Recent and nothing is written.

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

Draft Canvas stays a click away. On macOS it has a menu-bar icon, on Windows a system-tray icon. Clicking it opens
a small panel beside it, Home in miniature:

- **New Quick Draft**
- **Drafts**: Quick Drafts waiting to be carried on with, and **Recent**: your last few files, each drawn as the
  diagram it is
- **Open…**, **Project…**, **New file…**
- the name at the top brings the window forward; **Settings** and **Quit** sit beside it

Clicking anywhere else, or `Esc`, puts the panel away. On Windows, right-clicking the icon opens the same things as
a plain menu. The icon wears a small dot while a draft is unsaved.

Closing the window hides it rather than quitting, so the next Quick Draft is instant. The first time, Draft Canvas
tells you where it went and asks whether that's what you want; **Settings** changes it later. **Quit** (from the
menu, `⌘Q`) really quits. Logging out or shutting down never waits on Draft Canvas: anything unsaved is already
kept.

While hidden, Draft Canvas does nothing. It doesn't watch your keyboard, mouse, screen, meetings or other apps,
and doesn't look through your disk for diagrams. It only ever touches the files and folders you choose, and its
own data folder. The one thing it asks the network is whether there's a newer version (below), and it can be
turned off.

## Updates

Draft Canvas looks for a newer version shortly after it starts and once a day after that. That's all it does
on its own: it reads one small file from this project's GitHub releases, and sends nothing about you or your
diagrams.

When there's a newer version, a small **Update available** appears in Home's corner and in the status bar.
It opens what's new, with **Download** and **Later**. Downloading doesn't interrupt anything, and every
download is checked against a signature built into the app before it can be installed. When it's ready,
**Update and restart** keeps anything unsaved first, and asks about a file with changes, exactly as quitting
would. Choose **Cancel** there and you keep working; the update waits.

**Settings → Updates** has **Check for updates automatically** (on unless you turn it off) and **Check for
updates**. How updates are built, signed and published is in [Desktop updates](desktop-updates.md).

## Keyboard

Everything in the editor works as it does everywhere else in Draft Canvas ([the shortcuts](keyboard-and-commands.md)).
The desktop adds the file shortcuts, in the menu as well. They work while Draft Canvas is the app in front;
none of them is system-wide.

| Shortcut | Does |
| --- | --- |
| `⌘N` / `Ctrl+N` | New Quick Draft |
| `⌘⇧N` / `Ctrl+Shift+N` | New File… |
| `⌘O` / `Ctrl+O` | Open… |
| `⌘⇧O` / `Ctrl+Shift+O` | Add Project… |
| `⌘S` / `Ctrl+S` | Save |
| `⌘⇧S` / `Ctrl+Shift+S` | Save As… |
| `⌘W` / `Ctrl+W` | Close the window (it stays in the menu bar or tray) |
| `⌘F` / `Ctrl+F` | Find a diagram, on Home: every project, recent file and draft |
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

The desktop app has no version or release of its own: every Draft Canvas release (`vX.Y.Z`, the version in
`package.json`) includes it. `.github/workflows/release.yml` creates the release, and
`.github/workflows/desktop-release.yml` builds the two macOS `.dmg`s (Apple Silicon and Intel) and the
Windows (x64) installer into it, with a checksum file and a build attestation. The Intel build is
cross-compiled on the same arm64 runner as the Apple Silicon one, which is why there is no third
machine in the matrix.

Before a release, the desktop app can have previews: a `desktop-vX.Y.Z-alpha.N` tag builds a prerelease of its
own, titled "Draft Canvas X.Y.Z-alpha.N", whose `X.Y.Z` may lead `package.json`'s. Its notes are its dated section of
`CHANGELOG.md` — the Shared and Desktop parts of it, generated the same way as any release's (see
[Release notes](../../CONTRIBUTING.md#release-notes)).

The installers are **not signed or notarized**: that needs paid developer certificates. The operating system
therefore warns the first time, and the release notes say how to continue:

- **macOS:** open **System Settings → Privacy & Security** and choose **Open Anyway** for Draft Canvas.
- **Windows:** in SmartScreen, choose **More info → Run anyway**. The installer is per-user and needs no
  administrator rights.

Signing can be added later without changing anything else; there is deliberately nothing about it in the workflow
today. Every release is also an update installed copies are offered, signed with the project's own update key;
[Desktop updates](desktop-updates.md) has the one-time setup and what the workflow checks.
