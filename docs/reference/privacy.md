# Privacy

Draft Canvas does not upload diagrams, send telemetry or require an account. Editing works locally.
Exports, share links, live sessions and optional coding agents can carry content elsewhere when you use them.

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

## Live collaboration

A live session sends the diagram only to the people in it. The owner's editor hosts the session;
nothing passes through a Draft Canvas server, and the owner's copy is the only one saved.

- **Draft Canvas collects no diagrams, live or otherwise.** A session's diagram travels only between
  the people in it.
- **Browser sessions** use WebRTC data channels, encrypted end to end by DTLS between the two
  browsers. To find a route between networks, each browser asks a STUN server (by default
  `stun.cloudflare.com`, or one you name) for its public address; the STUN server sees IP addresses,
  never diagram content. The owner decides for everyone: a collaborator's browser asks a STUN server
  only when the owner's connection offer shows the owner asked one.
- **Only my network** contacts no STUN server and no relay, on the owner's side or any
  collaborator's: people join by direct invite (or the desktop's local network link), and nothing
  leaves your network.
- **The rendezvous relay** (`relay.draftcanvas.dev`) lets someone holding a session link ask to join
  and receive the owner's answer before the two browsers connect. It passes along a few small
  messages — the joiner's name and connection details — every one encrypted with a key that exists
  only in the session link's `#` fragment, which is never sent to it. It sees a random room id, IP
  addresses and timing; it cannot read the messages and never receives the diagram. It stores no
  messages, diagrams or names — only, for each room, the SHA-256 of a secret the owner's browser made
  (never in the link), so nobody else can host the room; that is deleted within 12 hours.
  Self-hosted builds can point at their own relay or none (`VITE_COLLAB_RELAY`); without one, direct
  invites still work.
- **Direct invite links and reply codes** carry connection details — including the network addresses each
  browser found — after the URL's `#`, which is not sent to the app's host. An invite works once,
  for one person, and expires after 30 minutes. The page takes it off the address as soon as it is read.
- **The desktop app's local network link** serves the editor and relays the session over plain HTTP
  and WebSocket on your local network, authenticated by a random 128-bit token in the link. That
  traffic is **not encrypted**: use it on a network you trust or through a VPN.
- **A collaborator's copy** is never written to their browser storage. They keep the diagram only by
  making an editable copy, which then lives in their own Library like any other diagram.
- **Presence** — names you type, pointer positions, selections — goes to the session's members and is
  never stored. Your name is kept as a preference in this browser for next time.

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

Open **Troubleshooting** on the web home screen, **More → Diagnostic report…** in the web editor,
or **Settings → Support** on desktop to preview up to twenty recent failure categories, timestamps,
versions and optional element counts. It excludes raw errors, stacks, diagram content, identifiers,
URLs and file paths. The report stays in memory until reload; downloading saves a local JSON file
and never uploads it. See [Local diagnostic reports](reliability.md#local-diagnostic-reports).
