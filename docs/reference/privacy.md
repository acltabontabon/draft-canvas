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

A share link carries the whole diagram after the URL's `#`, including text, code and nested rooms.
The fragment is not sent to the app host. Background images are excluded. Desktop links point to
`app.draftcanvas.dev`, where they open in a browser.

Before compression, shared snapshots receive compact internal ids, with every connection, nested
level, Flow, attachment and open-point reference updated together. The original document is not
changed. Labels, notes, code, source evidence, geometry and styling are retained. File identity and
timestamps are assigned afresh on arrival, as with older links. Packing and compression run locally;
there is no short-link service, upload or remote lookup. Existing links remain readable.

- **Require a passphrase** is enabled by default. The compressed diagram and its starting metadata
  are encrypted locally with AES-256-GCM and a PBKDF2-SHA-256 key (600,000 iterations, a fresh
  16-byte salt and a fresh 12-byte IV per link). The passphrase and key are not included in the URL,
  saved or sent to a server. Decryption happens locally after the recipient enters the passphrase.
- With protection off, anyone with the link can read the diagram. Existing unprotected links remain readable.
- Neither kind of link expires or can be revoked. Browsers and messages may retain copies.
  A recipient can save or capture content after unlocking it; read-only controls are not copy protection.
- Guided reader fixes shape positions, allows navigation and Flow playback, and never saves the
  snapshot into the Library. **Lock** discards the decrypted document and its undo history.
- Links are capped at 32 KB of encoded payload; larger diagrams need a file export.

Send the passphrase separately from the link. A forgotten passphrase cannot be recovered. For
larger protected diagrams, use a `.dcenc` export. See [Saving and sharing](../guides/saving-and-sharing.md).

## Live collaboration

Only session members receive the diagram, and only the owner's copy is saved.

| Part | Sees or carries |
| --- | --- |
| Browser connection | WebRTC, encrypted end to end |
| STUN (`stun.cloudflare.com` or yours) | IP addresses, to find a route; collaborators use one only if the owner does |
| Relay (`relay.draftcanvas.dev`) | Encrypted join messages, a room id, IP addresses. Never the diagram. |
| **Only my network** | No STUN and no relay |
| Invite links, reply codes | Network addresses after the `#`; one use, 30 minutes |
| Desktop local network link | Plain HTTP; the 128-bit token is proved, never sent. **Not encrypted.** |
| Presence | Names, pointers, selections; never stored |

- The relay's key exists only in the link's `#`. It stores only a hash of the owner's secret, until 12 hours after the owner was last connected.
- Collaborators' copies are never saved unless they choose **Make an editable copy**.

## Optional AI agents

Off by default and limited to folders you allow.

**Your coding agent may send diagram content to its AI provider**, as it does with code.

`agent/ledger.jsonl` keeps request ids, fingerprints, receipts and paths, not content: resolved
entries up to 7 days (at most 2,000), unresolved 30 days. See [Agent security](agent-integration.md#security).

**Nodi** (desktop) runs your own Claude Code or Codex on your machine, signed in as you; what you type
and what the agent reads go to that agent's provider, as with any prompt. Draft Canvas sends nothing
itself. The conversation shown is kept in memory only; the agent keeps its own session files
(`~/.claude/projects`, `~/.codex/sessions`), and Draft Canvas keeps which session belongs to which
diagram in `companion/sessions.json` in the app's data folder. A run's working folder holds only its
connector configuration and is removed when the run ends. Nodi reads no code unless you allow it in
the chat, and then only the one project folder, read-only and without secret files; what it reads
goes to the agent's provider like the rest of the turn.

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
