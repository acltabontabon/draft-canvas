# Saving, backing up and sharing

## Save your work

- **Web:** saves automatically in this browser profile. Wait for **Saved locally** before closing.
- **Desktop:** `⌘S` saves to a file; see [desktop files](desktop.md#files).

Browser diagrams do not sync between devices, browsers or sites, and clearing site data deletes them.
If the status bar says **In memory only**, nothing is stored: export before closing.
If another tab changed the same diagram, choose **Keep mine** or **Load the other tab's**.

## Back up the browser library

1. On Home, choose **View all** to open the Library.
2. Choose **Back up** to download a ZIP of every diagram and project.
3. To bring it back, choose **Restore…**. Existing diagrams are never overwritten; matches come back
   as copies.

The Library reminds you when the last backup is missing or over a week old. Press `/` there to
search; deleting a project moves its diagrams to **Unorganized**.

## Export a file

Open **Share → Export** (`⌘⇧E`).

| Choose | You get |
| --- | --- |
| **Document → Editable** | A `.draftcanvas` file to reopen, share or keep in version control |
| **Document → Encrypted** | A passphrase-protected `.dcenc` file |
| **Image** | PNG or SVG |
| **Source → Flows** | Mermaid or PlantUML sequence diagrams of your flows |
| **Source → Architecture** | Mermaid flowchart, C4-PlantUML, Structurizr DSL or draw.io |

![Export with Document selected.](../media/guides/export-document.png)

- Exports are snapshots, made on your device. Documents include every room, and a background
  image up to 2 MB.
- An encrypted file needs a passphrase of 8 or more characters. It cannot be recovered, so send it
  separately. Open `.dcenc` files in the web app.
- **Copy** puts an image or source on the clipboard; `⌘K` has **Copy as image**, **Copy as SVG**
  and **Copy source as…**. If the clipboard refuses, the file downloads instead.

Image options:

- **Light** or **Dark**, **Transparent**, **Selection only**; PNG at 1×, 2× or 3×.
- Inside a room: that room or **The whole canvas**. **Every level** zips one image per room.
- Open-point markers are included unless you untick them.
- **Editable — carries the diagram inside** embeds the whole diagram, every room, so the image can
  be imported and edited. On by default for SVG, off for PNG.

## Import a file

Choose **Import** on Home or in the Library, or drop the file onto the Library or canvas.

- `.draftcanvas` or `.json`: opens as a diagram.
- `.dcenc`: asks for the passphrase (web only).
- Editable PNG or SVG: opens the diagram inside.
- Mermaid `.mmd`, `.mermaid` or Markdown: see below.

An import never replaces an existing diagram. Older files upgrade; files from a newer version are
refused until you update. Damaged files are repaired where possible, with a report of what was
dropped. Files over 24 MB are refused; other limits are in the [schema reference](../reference/schema.md).

### Importing a Mermaid flowchart

Import a `flowchart` or `graph` file for a new diagram, or paste Mermaid text onto a canvas (one
undo removes it). Draft Canvas lays it out. Styling is skipped; other diagram types are refused.
See the [Mermaid import reference](../reference/mermaid-import.md).

## Share a diagram

| Send | How |
| --- | --- |
| Read-only link (web) | **Share → Copy read-only link**, or **Copy share link** in `⌘K` |
| File | **Export → Document** |
| Picture | **Export → Image**, or **Copy as image** |
| Live session | **Share → Draw together, live**; see [Collaborating live](collaborating.md) |

A share link carries the whole diagram, every room, after the `#`; nothing is uploaded.

- Anyone with the link can read it. Links never expire and do not update.
- The recipient can choose **Make an editable copy** to keep their own.
- Up to 32 KB compressed, without background images. For larger or private diagrams, send a file.

To pick where reading starts, run **Share from here…** in `⌘K`, or use **Start at** in
**Export → Document**: **Diagram overview**, **Current level** or a flow.

## If something looks wrong

| Problem | Try |
| --- | --- |
| Empty Library | Use the same browser profile and site, outside a private window. |
| Storage full or unavailable | Export now, then free space or use another browser. |
| Saving stopped after an update | Export recent changes, then reload. |
| A diagram cannot be read | Restore from a backup. |

For a bug report, choose **Diagnostic report…** in the **?** help menu (desktop: **Settings →
Support**), then **Download report**. It has no diagram content or file paths and is never sent
automatically. See [privacy](../reference/privacy.md) and [recovery limits](../reference/reliability.md).
