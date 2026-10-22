# Draft Canvas Desktop

Use the same editor on macOS (Apple Silicon or Intel) and Windows (x64), with local files,
project folders and Quick Drafts. No account is needed.

## Installing

Download an installer from the [latest stable release](https://github.com/acltabontabon/draft-canvas/releases/latest).
On macOS 12 or later, you can also use Homebrew:

```bash
brew install --cask acltabontabon/tap/draft-canvas
```

Current installers are ad-hoc signed on macOS and unsigned on Windows. If the OS prompts,
use **System Settings → Privacy & Security → Open Anyway** on macOS,
or **More info → Run anyway** in Windows SmartScreen. Check the release notes for details.

## Quick Draft

Choose **Quick Draft** on Home, or **New Quick Draft** from the File or tray menu (`⌘N` / `Ctrl+N`).
Start drawing without choosing a name or folder.

![Desktop Home with Quick Draft, Open file and Connect an agent.](../media/guides/desktop-home.png)

Quick Drafts are kept in the app's data folder until you **Save** (`⌘S`) or **Move into Project…**.
They reappear under **Drafts** after closing or restarting. Discard one from Home when finished.
An untouched blank draft leaves nothing behind.

**Try an example** opens a ready-made Quick Draft. **View all** opens the gallery;
**Everything** searches drafts, recent files and registered projects.

## Files

| Action | How |
| --- | --- |
| Open | `⌘O`, drag a file onto the window, or double-click it in Finder / Explorer |
| Save | `⌘S`; a Quick Draft asks for a location on its first save |
| Save a copy | **Save As…** (`⌘⇧S`) |
| Create a named file | **New File…** (`⌘⇧N`) |
| Rename on disk | **Rename File…** in the File menu |
| Discard file edits | **Revert to Saved…** |
| Find the file | **Reveal in Finder** / **File Explorer** |

On Windows, use `Ctrl` for `⌘`. The explorer previews diagrams and adds `.draftcanvas` to saved names.
Replacing an existing file requires confirmation.

Files change when you save. Unsaved work has a separate recovery copy, and closing asks what to do.
An allowed agent may save its changes automatically only when you had no unsaved edits.

If another app changes the file, Draft Canvas reloads it when there are no local edits.
Otherwise it keeps your work and asks before replacing the disk copy.
Failed saves leave your work on screen.

## Folders as projects

1. On Home, choose **Projects → Add project…** (`⌘⇧O`).
2. Browse to a folder, or create one with **New folder**.
3. Choose **Add project** to link it to Home.

![The folder explorer with navigation and a diagram preview.](../media/guides/desktop-explorer.png)

A project is an ordinary folder of `.draftcanvas` files. Subfolders stay browsable;
**New canvas here** creates a diagram in the current folder.
**Find a diagram** (`⌘F` on Home) searches projects, recent files and drafts.
**Remove from Home** forgets a project without deleting its files.

Keep diagrams beside code, for example `docs/architecture.draftcanvas`.
Web and desktop use the same file format. To move a browser diagram here,
use **Export → Document → Editable** and open the file.
Open encrypted `.dcenc` files in the web app; desktop can export them but cannot open them yet.

## The menu bar and system tray

Closing the window can keep Draft Canvas in the menu bar or tray.
Use its menu to reopen the window, open Settings or quit.
Change close behavior in **Settings → General**. **Quit** (`⌘Q` / `Ctrl+Q`) exits the app.

To let a coding agent draw or update diagrams, see [Connect an AI agent](connect-an-ai-agent.md).
That guide also covers when the window must stay open.

## Settings

Open **Settings…** (`⌘,` / `Ctrl+,`) from the app or tray menu. Changes apply immediately.

| Category | Controls |
| --- | --- |
| **General** | Window-close behavior |
| **AI agents** | Agent setup and allowed folders |
| **Updates** | Automatic checks and manual checking |
| **Support** | Diagnostic report |

## Diagnostic reports

Open **Settings → Support**, review the report, then choose **Download report**.
It includes failure categories and timestamps without diagram content or file paths.
Nothing is sent automatically. Licences are under **About → Licences**.

## Updates

The app checks GitHub Releases shortly after launch and daily. You can disable this in **Settings → Updates**.
An available update offers **Download**, then **Update and restart**. Downloads are signature-checked;
restart asks about unsaved files. **Cancel** leaves the update waiting.

For Homebrew upgrades, quit first, then run:

```bash
brew upgrade --cask --greedy acltabontabon/tap/draft-canvas
```

Uninstalling the cask keeps diagrams and recovery data.

## Keyboard

| Shortcut (Mac) | Action |
| --- | --- |
| `⌘N` / `⌘⇧N` | Quick Draft / New File |
| `⌘O` / `⌘⇧O` | Open / Add project |
| `⌘S` / `⌘⇧S` | Save / Save As |
| `⌘F` on Home | Find a diagram |
| `⌘W` / `⌘Q` | Close window / quit |
| `⌘,` | Settings |

Use `Ctrl` on Windows. See [editor shortcuts](keyboard-and-commands.md) for drawing and presentation.

## Building it yourself

Install Node 22.14 or later, [Rust](https://www.rust-lang.org/tools/install), and
[Tauri's system prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```bash
npm ci
npm run desktop:dev      # development app
npm run desktop:build    # installer in src-tauri/target/release/bundle/
npm run desktop:check    # desktop build, Rust and version checks
```

For editor checks, see [Contributing](../../CONTRIBUTING.md).
Maintainers: [desktop releases](../reference/desktop-updates.md#versions),
[signing](../reference/desktop-updates.md#the-three-kinds-of-signing) and
[Homebrew publication](../reference/desktop-updates.md#homebrew-releases).
