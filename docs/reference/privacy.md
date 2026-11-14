# Privacy and security

No account, telemetry or diagram backend. Diagrams leave your device only when you export, share,
collaborate or connect a coding agent. The optional starters gallery downloads public diagrams;
it never uploads yours.

## Reporting a concern

[Report a vulnerability privately](https://github.com/acltabontabon/draft-canvas/security/advisories/new)
on GitHub. Include your Draft Canvas version, platform, steps to reproduce, and the impact.

If private reporting is unavailable, open an issue asking for a private channel. Keep the
vulnerability details out of the public issue. Draft Canvas has no bug bounty or guaranteed
response time.

### Supported versions

- **Web and desktop:** the latest stable release. Security fixes are released without backports.
- **Desktop previews:** supported until the next preview or the release they lead to.

## Threat model

Draft Canvas validates imports and agent requests, limits native file access, authenticates encrypted
exports, and verifies desktop update signatures. Keep your browser profile and device secure. Someone
with access to an unlocked session, a plain file, or an unprotected share link can read or copy the diagram.

## What is stored, and where

### Browser storage

Web diagrams stay in this browser profile and do not sync.

| Location | Contents |
| --- | --- |
| IndexedDB `draft-canvas` | Stores `bodies`, `documents` (titles, thumbnails), `projects` (folders), `backgroundImages` |
| IndexedDB `draft-canvas-keys` | Key for legacy encrypted records, read-only |
| IndexedDB `draft-canvas-starters` | Downloaded starters gallery, when you load it; never your diagrams |
| Cache Storage | Offline app files, never diagrams |
| localStorage | Short preferences, such as theme, export choices and live-session name |
| sessionStorage | Unsaved edits held across a reload, removed once restored |

- Diagrams are plain records. Anyone with access to the profile can read them. Older encrypted
  records are decrypted with the profile's legacy key and stored plain on the next save. If that
  key is lost, those records cannot be read.
- Without IndexedDB, the status bar says **In memory only** and closing the tab loses the work.

### The desktop app

- Diagrams are `.draftcanvas` files where you save them, with background images beside them.
- The app's data folder holds recent files, settings and recovery copies, removed once saved or
  discarded.
- It reads only files and folders you pick, plus folders you allow for agents. **Use in docs**
  writes its pictures beside the saved diagram and adds one line to a Markdown file you choose.

## What leaves your machine

No analytics, error reporting or webfonts. The Content-Security-Policy blocks other connections.

- **Web app:** the service worker fetches app updates from the same address, never diagrams.
- **Desktop updates:** checks go to GitHub without diagram data. Draft Canvas verifies the update
  signature before installing. Downloads start when you ask.
- **Starters gallery (optional):** off until you choose **Load starters**. Then Draft Canvas reads
  public files from `raw.githubusercontent.com/acltabontabon/draft-canvas-starters`: when the
  Starters dialog is opened and the copy is a day old, or when you refresh it. Requests carry no
  cookies, credentials, referrer or diagram data. **Stop loading starters** ends them and forgets
  the downloaded copy. See [Architecture examples](../guides/examples.md).

## Exports and imports

Both run locally.

- Anyone can read `.draftcanvas` files, ZIP backups and PNG/SVG exports that embed the diagram.

### Passphrase-protected export (`.dcenc`)

Each export uses AES-256-GCM with a fresh 12-byte nonce. The key is derived from your passphrase
using PBKDF2-HMAC-SHA256 with 600,000 iterations and a fresh 16-byte salt. The key and passphrase
are never stored. Import authenticates and validates the file locally. An altered file or incorrect
passphrase fails to open. Keep the passphrase safe, since it cannot be recovered. This protection
applies only to the exported file.

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

- The relay carries encrypted join messages. The encryption key stays in the link's `#` fragment.
  The relay stores only a hash of the owner's secret, until 12 hours after the owner last connected.
- Session links carry the owner's signing-key fingerprint so guests can verify the owner. The owner
  enforces viewer and editor roles and validates incoming changes before applying them.
- Share invites only with the intended recipients. Use the desktop local network option only on
  networks you trust.
- Collaborators' copies are never saved unless they choose **Keep a copy** or **Make an editable copy**.
  Someone the owner removes is not offered either.

## Optional AI agents

Off by default and limited to folders you allow.

**Your coding agent may send diagram content to its AI provider**, as it does with code.

`agent/ledger.jsonl` keeps request IDs, fingerprints, receipts, and paths. Resolved entries are
kept for up to 7 days (at most 2,000), and unresolved entries for up to 30 days.

**Nodi** (desktop) runs your own Claude Code or Codex on your machine, signed in as you; what you type
and what the agent reads go to that agent's provider, as with any prompt. Draft Canvas sends nothing
itself. The conversation shown is kept in memory only; the agent keeps its own session files
(`~/.claude/projects`, `~/.codex/sessions`), and Draft Canvas keeps which session belongs to which
diagram in `companion/sessions.json` in the app's data folder. A run's working folder holds only its
connector configuration and is removed when the run ends. Nodi reads no code unless you allow it in
the chat, and then only the one project folder, read-only and without secret files; what it reads
goes to the agent's provider like the rest of the turn.

### Desktop and agent boundaries

The editor receives handles to the files and folders you choose. Coding agents connect through a
user-only socket or named pipe, with a token that **Disconnect agents** replaces. Draft Canvas
checks folder permissions on each request. Nodi runs are scoped to one diagram and use proposals
unless you enable direct edits. Run a trusted agent CLI, since these controls depend on the CLI you install.

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
