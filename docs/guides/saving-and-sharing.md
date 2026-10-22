# Saving, backing up and sharing

The web app saves in the current browser profile. Desktop saves to files you choose.
Use exports or backups to keep an independent copy.

## Save your work

| Where | How saving works |
| --- | --- |
| Web | Autosaves after a short pause. Wait for **Saved locally** before leaving. |
| Desktop | Press `⌘S` / `Ctrl+S`. Unsaved work has a recovery copy; see [desktop files](desktop.md#files). |

Browser diagrams do not sync between devices, browsers or origins.
Clearing site data deletes them. If the status says **In memory only**, export before closing the tab.
If two tabs edit the same diagram, choose **Keep mine** or **Load the other tab's** when prompted.

## Back up the browser library

1. Choose **View all** on Home to open the Library.
2. Choose **Back up** to download a ZIP of all diagrams and project folders.
3. Keep the ZIP somewhere safe. Use **Restore…** to bring it back.

Restore never overwrites an existing diagram; matching IDs become copies.
If a backup reports unreadable diagrams, keep an older complete backup too.
The Library reminds you when a backup is missing or over a week old.
Browser persistence does not protect against clearing site data or losing the device.

## Reopening a diagram

Choose **View all** on Home, then click a diagram. Press `/` to search by title or project.
The Library also offers rename, duplicate, delete and project organization.
Deleting a project moves its diagrams to **Unorganized**.

## Export a file

Open **Export** (`⌘⇧E` / `Ctrl+Shift+E`):

| Choose | Output | Use it for |
| --- | --- | --- |
| **Document → Editable** | `.draftcanvas` JSON | Reopening, sharing or version control |
| **Document → Encrypted** | `.dcenc` | A passphrase-protected copy |
| **Image** | PNG or SVG | Slides, docs and chat |
| **Source → Flows** | Mermaid or PlantUML sequence diagrams | Documenting an authored flow |
| **Source → Architecture** | Mermaid flowchart, C4-PlantUML, Structurizr DSL or draw.io | Other documentation and diagram tools |

![Export with Document selected.](../media/guides/export-document.png)

An export is a snapshot; later edits do not update it. Exporting happens locally.
Editable documents contain every room. Background images travel in document exports only up to 2 MB;
the dialog reports larger ones. Project membership stays in the Library.

Encrypted files require a passphrase of at least eight characters. Draft Canvas cannot recover it.
Send the passphrase separately. Open `.dcenc` files through the web Library; desktop cannot open them yet.

### Image options

Choose a Light or Dark palette, transparency, and whether to export only the selection.
PNG offers 1×, 2× or 3× scale; the preview reports the actual size. SVG is vector.
Inside a room, choose that level or the whole canvas. Open-point markers are included unless unticked.

### Copy instead of download

Choose **Copy** beside an image or source export. The command palette also has **Copy as image**,
**Copy as SVG** and **Copy source as…**. If image copying is unavailable, the app downloads a file
and tells you why.

### Editable images

Tick **Editable — carries the diagram inside** to embed the whole diagram in a PNG or SVG.
Import the image to edit it again. This is on by default for SVG, off for PNG.

Anyone with an editable image can read every room, even if the picture shows only a selection.
Background images are not embedded.

## Import a file

Choose **Import** on Home or in the Library, or drop a file onto the Library or canvas.

- `.draftcanvas` and `.json` open as editable diagrams.
- `.dcenc` asks for its passphrase in the web Library.
- Editable PNG and SVG files reopen their embedded diagram.
- Mermaid flowcharts import from `.mmd`, `.mermaid` or a Markdown Mermaid block.

An existing diagram with the same ID is kept; the import becomes a copy.
Older files upgrade on import. Newer unsupported versions are refused; update the app to open them.

### Repairs, limits and compatibility

Recoverable problems are repaired with a report of dropped content.
Files over 24 MB are refused. Document limits are 5,000 shapes, 10,000 connectors, 50 flows
and three nested rooms. See the [schema reference](../reference/schema.md).

### Importing a Mermaid flowchart

Import a `flowchart` or `graph` file to create a new diagram, or paste Mermaid text onto a canvas
to add it beside existing content. Undo removes a pasted import in one step.
Draft Canvas lays out the result.

Common shapes, labelled arrows, chains and nested subgraphs are supported. Styling and interactive
directives are skipped with a notice; other diagram types, such as `sequenceDiagram`, are refused.
Limits: 300 shapes, 600 arrows, 60 subgraphs and 512 KB of text.
See the [Mermaid import reference](../reference/mermaid-import.md) for mappings and skipped syntax.

## Share a diagram

| Send | How | Recipient gets |
| --- | --- | --- |
| Link | **Copy share link** in `⌘K` or **Export → Document** | A read-only snapshot; **Make an editable copy** saves their own version |
| File | **Document → Editable** or **Encrypted** | A diagram they can reopen |
| Picture | **Image**, or **Copy as image** | A PNG or SVG; editing requires an embedded diagram |
| Live session | **Collaborate** in the toolbar | The canvas itself, edited together in real time; see [Collaborating live](collaborating.md) |

Share links contain the whole document after the `#`; nothing is uploaded.
Anyone with the link can read it. Links do not expire, and later edits do not update them.
The compressed limit is 32 KB; export a file if the diagram is too large.
Background images are omitted. For private content, use an encrypted file instead.

### Choose where a shared explanation begins

Run **Share from here…** in `⌘K`, or use **Start at** in **Export → Document**.
Choose **Diagram overview**, **Current level** or a playable flow.
The quick **Copy share link** command always starts at the overview.

The starting point changes where reading begins. **Every room is still shared.**
If the requested level or flow is unavailable, the link opens at the overview with a notice.

## If something looks wrong

| Problem | Next step |
| --- | --- |
| Empty Library | Check the browser profile, origin and private-window status. |
| Storage full or unavailable | Export now; free space or use another browser. |
| Another tab changed the diagram | Choose which copy to keep; export your copy first if unsure. |
| Saving stopped after an app update | Export recent changes, then reload. |
| A saved diagram cannot be read | Import a backup. Corrupted records or lost legacy encryption keys may be unrecoverable. |

For a bug report, open **More → Diagnostic report…** on web or **Settings → Support** on desktop.
Review it and choose **Download report**. It excludes diagram content and file paths and is never sent automatically.
See [recovery limits](../reference/reliability.md#recovery-guarantees-and-limits) and [privacy](../reference/privacy.md).
