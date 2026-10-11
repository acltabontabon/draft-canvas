# Privacy

Draft Canvas does not upload diagrams, send telemetry or require an account. Editing works locally.
Exports, share links and optional coding agents can carry content elsewhere when you use them.

## What is stored, and where

### Browser storage

The web app stores diagrams in the browser profile for the origin serving it. Copies in different
browsers or devices do not sync.

| Location | Contents |
| --- | --- |
| IndexedDB `draft-canvas` → `documents` | Titles, timestamps, counts and topology thumbnails |
| IndexedDB `draft-canvas` → `bodies` | Full diagrams, including text, code, rooms, flows, settings and viewport |
| IndexedDB `draft-canvas` → `projects` | Library folder names |
| IndexedDB `draft-canvas` → `backgroundImages` | Canvas background images as blobs |
| IndexedDB `draft-canvas` → `fileAssociations` | Dormant development-build links; unused and never exported |
| IndexedDB `draft-canvas-keys` → `keys` | Legacy encryption keys, read only for older diagrams |
| Cache Storage | Offline app assets, never diagrams |
| localStorage | UI preferences, recent command ids, export choices and backup/release timestamps |
| sessionStorage | Unsaved edits stashed during reload, removed after restoration |

Diagrams are **plain records since 1.12**. Older bodies remain AES-256-GCM encrypted until next
saved, using the key left in the same profile; new profiles do not create legacy keys. Anyone with
access to your browser storage can read current diagrams. See [Security](../../SECURITY.md#browser-storage)
for the encryption boundaries.

If IndexedDB is unavailable, the status bar says **In memory only**. Undo history, selection,
presentation and previews also remain in memory. Closing the tab discards in-memory state.

### The desktop app

Desktop diagrams are ordinary `.draftcanvas` files in locations you choose. Background images are
written beside their diagrams. The app keeps recent file/folder lists, settings and plain-text
recovery copies in its own data folder; recovery copies are removed when saved or discarded.
It uses files rather than the web Library, and the two do not sync.

Native file access is limited to files and folders you select or open through the OS, plus the
app's own storage. Optional agent access extends this to project folders you explicitly allow.

## What leaves your machine

Draft Canvas has no diagram backend, analytics or automatic error reporting. It uses system fonts.
The editor's network restrictions are enforced by source checks and the production Content Security Policy.

- **Web delivery:** the browser fetches app assets. The offline service worker may fetch updated
  assets from the same origin; it does not read diagrams or IndexedDB content.
- **Desktop updates:** the native updater contacts GitHub for update checks and downloads, without
  sending diagrams. Automatic checks can be disabled; downloads and installation require your action.
  See [Desktop updates](desktop-updates.md).
- **External links:** opening a link hands it to your browser.

## Exports and imports

Files are generated, read, validated and decrypted locally. Imports read only files you choose;
no import or export passes through a server.

Plain `.draftcanvas` files and ZIP backups expose their contents to anyone who receives them.
PNG and SVG exports can include the full editable diagram when that option is enabled.
A `.dcenc` export encrypts the diagram with a passphrase you choose. Draft Canvas does not store or
recover that passphrase, and encrypting an export does not encrypt the browser copy.

## Share links

A share link carries the diagram's text, code and nested rooms as compressed data after the URL's
`#`. That fragment is not sent to the app host. Background images are excluded.

- Anyone with the link can read the diagram. Links have no password, expiration or revocation.
- Browsers, messages and other places you paste the link may retain copies.
- Opening a link is read-only and does not save it. **Make an editable copy** creates a new Library entry.
- Links are capped at 32 KB of encoded payload; larger diagrams need a file export.

Use a `.dcenc` export for protected sharing. See [Saving and sharing](../guides/saving-and-sharing.md).

## Optional AI agents

Agent access is off by default and limited to allowed project folders. The connector uses a local
socket or pipe, not a network port. **Your coding agent may send diagram content to its own AI
provider**, just as it does with code; Draft Canvas does not control that provider.

The local `agent/ledger.jsonl` stores request ids, fingerprints, receipts and file paths, not diagram
content. Resolved entries are kept for up to seven days, capped at 2,000 entries; unresolved entries
are kept for thirty days. A connection secret is removed when access is turned off. See [Agent security](agent-integration.md#security).

## Storage limits and backups

Clearing site data deletes browser diagrams, and private windows may discard storage on close.
Browser quotas can stop saving; the app reports the failure so you can export your work.
Keep portable backups of diagrams you want to retain.

## Optional local diagnostic report

**Diagnostic report…** in About previews up to twenty recent failure categories, timestamps,
versions and optional element counts. It excludes raw errors, stacks, diagram content, identifiers,
URLs and file paths. The report stays in memory until reload; downloading saves a local JSON file
and never uploads it. See [Local diagnostic reports](reliability.md#local-diagnostic-reports).
