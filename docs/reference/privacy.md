# Privacy

No account, telemetry or diagram backend. Diagrams leave your device only when you export, share,
collaborate or connect a coding agent.

## What is stored, and where

### Browser storage

Web diagrams stay in this browser profile and do not sync.

| Location | Contents |
| --- | --- |
| IndexedDB `draft-canvas` | Stores `bodies`, `documents` (titles, thumbnails), `projects` (folders), `backgroundImages`; `fileAssociations` is unused |
| IndexedDB `draft-canvas-keys` | Legacy encryption key for diagrams saved before 1.12 |
| Cache Storage | Offline app files, never diagrams |
| localStorage | Short preferences, such as theme, export choices and live-session name |
| sessionStorage | Unsaved edits held across a reload, removed once restored |

- Diagrams are plain records since 1.12; anyone with access to the profile can read them. Older ones
  stay encrypted until next saved. See [Security](../../SECURITY.md#browser-storage).
- Without IndexedDB, the status bar says **In memory only** and closing the tab loses the work.

### The desktop app

- Diagrams are `.draftcanvas` files where you save them, with background images beside them.
- The app's data folder holds recent files, settings and recovery copies, removed once saved or
  discarded.
- It reads only files and folders you pick, plus folders you allow for agents.

## What leaves your machine

No analytics, error reporting or webfonts. The Content-Security-Policy blocks other connections.

- **Web app:** the service worker fetches app updates from the same address, never diagrams.
- **Desktop updates:** checks go to GitHub with no diagram data; downloads only when you ask. See
  [Desktop updates](desktop-updates.md).

## Exports and imports

Both run locally.

- Anyone can read `.draftcanvas` files, ZIP backups and PNG/SVG exports that embed the diagram.
- A `.dcenc` export is encrypted with your passphrase, which is never stored or recoverable. It does
  not encrypt the Library copy.

## Share links

The diagram travels after the link's `#`, which is never sent to the app's host. Background images
are left out.

- Anyone with the link can read it, including wherever it was pasted. No password, expiry or revocation.
- Links open read-only; **Make an editable copy** saves one. The limit is 32 KB of encoded data.

For protected sharing, use `.dcenc`. See [Saving and sharing](../guides/saving-and-sharing.md).

## Live collaboration

Only session members receive the diagram, and only the owner's copy is saved.

| Part | Sees or carries |
| --- | --- |
| Browser connection | WebRTC, encrypted end to end |
| STUN (`stun.cloudflare.com` or yours) | IP addresses, to find a route; collaborators use one only if the owner does |
| Relay (`relay.draftcanvas.dev`) | Encrypted join messages, a room id, IP addresses. Never the diagram. |
| **Only my network** | No STUN and no relay |
| Invite links, reply codes | Network addresses after the `#`; one use, 30 minutes |
| Desktop local network link | Plain HTTP with a 128-bit token. **Not encrypted.** |
| Presence | Names, pointers, selections; never stored |

- The relay's key exists only in the link's `#`. It stores only a hash of the owner's secret, for 12 hours at most.
- Collaborators' copies are never saved unless they choose **Make an editable copy**.

## Optional AI agents

Off by default and limited to folders you allow.

**Your coding agent may send diagram content to its AI provider**, as it does with code.

`agent/ledger.jsonl` keeps request ids, fingerprints, receipts and paths, not content: resolved
entries up to 7 days (at most 2,000), unresolved 30 days. See [Agent security](agent-integration.md#security).

## Storage limits and backups

- Clearing site data, or closing a private window, can delete browser diagrams.
- The app requests persistent storage; browsers may refuse, so eviction stays possible.
- A full quota stops saving, and the app says so. Keep backups.

## Optional local diagnostic report

**Help → Diagnostic report…** in the web editor, or **Settings → Support** on desktop.

- Up to 20 recent failure categories, times, versions and optional element counts.
- No error text, content, identifiers, URLs or paths.
- In memory until reload. **Download report** saves a local file; nothing is uploaded.

See [Local diagnostic reports](reliability.md#local-diagnostic-reports).
