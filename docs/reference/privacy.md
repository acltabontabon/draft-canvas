# Privacy and security

Draft Canvas has no account, telemetry or diagram backend. Diagrams leave your device only when you
export, share, collaborate, connect a coding agent or publish history to Git.

The optional starters gallery downloads public diagrams and style packs; it never uploads yours.

## Reporting a concern

[Report a vulnerability privately](https://github.com/acltabontabon/draft-canvas/security/advisories/new)
on GitHub. [SECURITY.md](../../SECURITY.md) covers supported versions, the threat model and how files,
agents and live sessions are protected.

## What is stored, and where

### Browser storage

In the web app, diagrams stay in your browser profile and do not sync. They are not encrypted:
anyone with access to the profile can read them.

| Location | Contents |
| --- | --- |
| IndexedDB `draft-canvas` | Object stores `bodies`, `documents` (titles, thumbnails), `projects` (folders), `backgroundImages` (retired; emptied each time the app opens) and `fileAssociations` (unused; kept from development builds) |
| IndexedDB `draft-canvas-keys` | Key for legacy encrypted records, read-only |
| IndexedDB `draft-canvas-starters` | Downloaded starters gallery and its style packs, when you load it; never your diagrams |
| IndexedDB `draft-canvas-styles` | Styles you make in **Settings → Appearance**; never your diagrams |
| IndexedDB `draft-canvas-history` | Each diagram's history, as Git objects, including content later deleted from the diagram (see [Diagram history](../guides/history.md#privacy)) |
| Cache Storage | Offline app files, never diagrams |
| localStorage | Short preferences, such as theme, export choices and live-session name |
| sessionStorage | Unsaved edits held across a reload, removed once restored |

### The desktop app

- Diagrams are `.draftcanvas` files where you save them.
- The app's data folder holds recent files, settings and recovery copies (removed once saved or
  discarded), and each diagram's history (`history/`) until you remove it in **Settings → History**.
  Removing a history deletes its revisions from this device only; exported or published copies are
  not affected.
- The app reads only files and folders you pick, plus folders you allow for agents. **Use in docs**
  writes its pictures beside the saved diagram and adds one line to a Markdown file you choose.

## What leaves your machine

No analytics, error reporting or webfonts. The Content-Security-Policy blocks other connections.

- **Web app:** the service worker fetches app updates from the same address, never diagrams.
- **Desktop updates:** checks go to GitHub without diagram data. Draft Canvas verifies the update
  signature before installing. Downloads start when you ask.
- **Starters gallery (optional):** off until you choose **Load starters**, or **Load style packs** in
  **Settings → Appearance**, which is the same choice. Then Draft Canvas reads public files from
  `raw.githubusercontent.com/acltabontabon/draft-canvas-starters` when it shows starters or style
  packs and its copy is a day old, or when you refresh it. Requests carry no cookies, credentials,
  referrer or diagram data. **Stop loading starters** ends them and forgets the downloaded copy.
- **Git (desktop, optional):** **Publish…** sends a diagram's history to a repository you connect,
  after you confirm the first time, then on the schedule you choose. **Push draft-canvas/…** sends a
  diagram's project branch to `origin`. Both use your own Git sign-in. See
  [Diagram history](../guides/history.md#publishing-and-project-repositories-desktop).

## Exports and imports

Both run locally. Anyone can read `.draftcanvas` files, ZIP backups and PNG/SVG exports that embed
the diagram. A passphrase-protected `.dcenc` export protects only that file, and a lost passphrase
cannot be recovered.

## Share links

A share link carries the whole diagram after the URL's `#`, including text, notes, code, source
evidence and nested rooms. The fragment is not sent to the app host. Desktop links point to
`app.draftcanvas.dev`, where they open in a browser.

The snapshot is shortened and compressed locally, without changing your document; there is no
short-link service, upload or remote lookup. File identity and timestamps are assigned afresh when
the link is opened.

- **Require a passphrase** is on by default. The compressed diagram is encrypted locally with
  AES-256-GCM and a PBKDF2-SHA-256 key (600,000 iterations, a fresh 16-byte salt and a fresh 12-byte
  IV per link). The passphrase and key are never in the URL, saved or sent to a server; the
  recipient decrypts locally. Send the passphrase separately: it cannot be recovered.
- With protection off, anyone with the link can read the diagram.
- Links never expire and cannot be revoked. Browsers and messages may keep copies, and a recipient
  can save or capture content after unlocking it: read-only is not copy protection.
- The reader never saves the snapshot into the Library. **Lock** discards the decrypted document and
  its undo history.
- Links are capped at 32 KB of encoded payload; for larger diagrams use a file export.

## Live collaboration

Only session members receive the diagram, and only the owner's copy is saved.

| Part | Sees or carries |
| --- | --- |
| Browser connection | WebRTC, encrypted end to end |
| STUN (`stun.cloudflare.com` or yours) | IP addresses, to find a route; collaborators use one only if the owner does |
| Relay (`relay.draftcanvas.dev`) | Encrypted join messages, a room id, IP addresses; never the diagram |
| **Only my network** | No STUN and no relay |
| Invite links, reply codes | Network addresses after the `#`; one use, 30 minutes |
| Desktop local network link | Plain HTTP, **not encrypted**; the 128-bit token is proved, never sent |
| Presence | Names, pointers, selections; never stored |

- The join messages' encryption key stays in the link's `#` fragment. The relay stores only a hash of
  the owner's secret, until 12 hours after the owner was last connected.
- Share invites only with the intended recipients. Use the desktop local network option only on
  networks you trust.
- Collaborators' copies are never saved unless they choose **Keep a copy** or **Make an editable
  copy**. Someone the owner removes is not offered either.

## Optional AI agents

Agent access is off by default and limited to folders you allow.

**Your coding agent may send diagram content to its AI provider**, as it does with code.

The desktop app logs coding-agent requests in `agent/ledger.jsonl` (request IDs, fingerprints,
receipts and paths) so a retried request is never applied twice. Finished entries are kept for up to
7 days (at most 2,000), unfinished ones for up to 30 days.

Draft Canvas runs no agent of its own and sends nothing itself: what your agent reads goes to that
agent's provider, as with any prompt you give it.

Agents can read summaries of the open diagram's history and preview a restore or merge. They read a
past revision in full only if you turn on **Let agents read past revisions in full** in
**Settings → History**. A past revision can include content since removed from the diagram (see
[Diagram history](../guides/history.md#agents-and-history)).

## Storage limits and backups

- Clearing site data, or closing a private window, can delete browser diagrams.
- The app asks for persistent storage, but a browser may refuse and still clear the app's data.
- When browser storage is full, saving stops and the app says so, with **Export** beside the message.
- A crash or power loss can still lose unsaved edits. Keep backups.

## Optional local diagnostic report

Open **Help → Diagnostic report…** in the web app, or **Settings → Support** in the desktop app.

The report lists up to 20 recent failure categories, with times, versions and optional element
counts, but no error text, content, identifiers, URLs or paths. It stays in memory until reload, and
nothing is uploaded: **Download report** saves a local file.
