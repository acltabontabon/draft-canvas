# Privacy implementation

This document exists so the privacy claim can be audited rather than believed.

> Your diagrams stay on your device. Draft Canvas does not upload or store your canvas on a
> server.

## What is stored, and where

### IndexedDB — database `draft-canvas`

Everything you draw. Four object stores:

| Store | Key | Contents | Encrypted? |
| --- | --- | --- | --- |
| `documents` | `id` | Title, created and updated timestamps, node and edge counts, and a small topology sketch (shape kinds and their relative positions, for the list thumbnail). Used to render the library list without loading any canvas. | No — plain text. |
| `bodies` | `id` | The full document: nodes, connections, text, code, viewport, settings. | No, since 2.0 — a plain record with a per-write stamp. A row written by a build from 1.0 to 1.11 is still AES-256-GCM ciphertext, read with the key that build left, until the diagram is next saved (see below). |
| `projects` | `id` | The names of the Library's flat project folders. | No — plain text, like the summaries. |
| `backgroundImages` | `id` | The optional canvas background image, one per diagram, as a blob. | No. A wallpaper is far less sensitive than diagram content, and encrypting a blob would add a lot of plumbing for little. If a background image is sensitive, don't use it. |

### IndexedDB — database `draft-canvas-keys`

One object store, `keys`, holding the non-extractable AES-256-GCM key a build from 1.0 to 1.11
generated to encrypt `bodies`. Since 2.0 it is only read (`src/crypto/keyStore.ts`), to open rows
those builds wrote; a profile that never had one never gets one. See
[`SECURITY.md`](../../SECURITY.md#browser-storage) for what it protected and why it was retired.

`draft-canvas` is written by `src/storage/IndexedDbRepository.ts`, and by nothing else.

The `documents` summary exists so the library screen can list your diagrams — including their titles
— without loading every one of them just to draw a list. Both stores are plain records: anything
with access to this browser profile's storage can read what is in them, exactly as it could read a
file in your user folder. That was true of the encrypted rows too for anything that could run the
app as you; the difference now is that a copy of the `bodies` store on its own is readable as well.
If a diagram must be protected at rest, keep it as a passphrase-encrypted export (`.dcenc`) rather
than in the browser.

If IndexedDB cannot be opened — a private window, a blocked-storage policy, some embedded
webviews — the app falls back to an in-memory store, and the status bar says **In memory only**
instead of claiming your work is saved.

### Cache Storage — the offline app shell

The compiled HTML, JS, CSS, and fonts/icons that make up Draft Canvas itself — never anything you
draw. Populated and managed entirely by the generated Service Worker (`dist/sw.js`, built by
`vite-plugin-pwa` from `vite.config.ts`, registered in `src/lib/serviceWorker.ts`), so a refresh or
reopen works with no internet connection after the first successful visit.

### localStorage

Short, named UI preferences only, every key prefixed `draft-canvas.`:

| Key | Holds |
| --- | --- |
| `personality` | The roughness preset |
| `continuation` | Whether next-move suggestions are on (`on`/`off`) |
| `command-recent.<n>`, `command-use.<id>` | The ids of the last few commands run, and a per-command counter for the palette. Command ids name actions ("add-service", "connect-to"), never elements |
| `export-mode`, `export-document-format`, `export-image-format`, `sequence-export-format` | The last Export dialog choices, so it opens where you left it |
| `clipboard-permission` | `granted`/`denied`: whether you already answered "Allow clipboard access?" for the right-click and ⌘K Paste commands, so you aren't asked again. Cmd/Ctrl+V never touches it: it reads the native paste event directly and never prompts |
| `last-seen-product-release` | The last version whose "What's New" you saw |

Nothing about a diagram's content is stored here.

All access goes through `src/lib/preferences.ts`, which namespaces keys and rejects any value
longer than 64 characters. No canvas content is written there, and a test
(`tests/privacy.test.ts`) fails the build if any other module touches web storage directly.

### In memory only

The undo/redo history, the clipboard, the current selection, and presentation state. None of it
is persisted anywhere; closing the tab discards it.

## What leaves your machine

Nothing you draw. Ever.

Draft Canvas makes no request that carries a diagram, a label, or anything else you've typed. There
is no backend, no API, no analytics endpoint, and no error reporting.

The one exception is delivery, not content: a Service Worker may make a same-origin request to
fetch a newer build of the app itself, in the background, only while online. It never touches
IndexedDB, never sees a document, and only ever talks to the same origin Draft Canvas is served
from.

Three independent mechanisms keep the actual promise — nothing you draw leaves your machine — true:

1. **No network code exists in the app.** `tests/privacy.test.ts` walks every file in `src/` and
   fails if it finds `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
   `importScripts`, or a dynamic import of a remote URL. The same test fails on `eval` or the
   `Function` constructor. (The Service Worker above is generated separately, at build time, by
   `vite-plugin-pwa` — it never runs inside, or has access to, the app's own document/canvas code.)

2. **The browser enforces it.** The production build ships this Content Security Policy:

   ```
   default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
   form-action 'none'; base-uri 'self'; object-src 'none'
   ```

   `connect-src 'self'` means the browser blocks every request to any other origin, including any
   a dependency might attempt — only a request back to Draft Canvas's own host is possible at all,
   and that's exactly the Service Worker's own asset-caching and update-check traffic. It is
   injected at build time only — the same directive would block Vite's hot-reload socket during
   development.

3. **A browser test asserts it.** `e2e/critical-journey.spec.ts` builds a diagram containing a
   deliberately sensitive label and asserts that no request carrying a body is ever made.

### Fonts

System font stacks only. No webfont is fetched, which is also why an exported PNG renders in the
right typeface.

### Exports

`.draftcanvas`, `.dcenc`, PNG, SVG and the Mermaid and PlantUML sequence sources (`.mmd`, `.puml`) are all generated in the page and handed to the
browser's download mechanism. No file passes through a server. What happens to a file after you
save it is, of course, up to you.

A plain `.draftcanvas` export is diffable JSON — anyone who gets the file can read the diagram, the
same way anyone who gets a source file can read it. `.dcenc` is the alternative when that's not
acceptable: a passphrase-protected export, encrypted with a key derived from a passphrase you
choose at export time (PBKDF2, ≥600,000 iterations, a fresh random salt per file), readable only by
someone who has both the file and that passphrase. Draft Canvas never stores the passphrase and has
no way to recover a forgotten one — see [`SECURITY.md`](../../SECURITY.md) for the full key lifecycle.

### Imports

Reading a file uses the `File` API on a file you chose. Nothing is uploaded. A plain
`.draftcanvas` import is validated, repaired, and capped before anything reaches the canvas
(`src/document/validate.ts`); a `.dcenc` import asks for its passphrase first, decrypts locally,
and only then feeds the same validator — a wrong passphrase fails cleanly rather than importing
garbage.

### The desktop app

Draft Canvas Desktop (`src-tauri/`) is this same app in a window of its own, built with the editor
bundled inside it. It makes no network requests for editing, has no account, and sends no telemetry
or analytics. The editor is loaded from the app's own files, not from a website, so nothing about the
diagram you draw needs a connection.

The desktop app treats a `.draftcanvas` file as the storage: the browser's IndexedDB is never opened,
and nothing is shared with the web app's library. What it touches on your
computer is limited to:

- **Files and folders you choose**: the ones you pick in an Open, Save or folder dialog, that the OS opens
  with the app (a double-click, drag and drop), or that appear in Recent. The app never holds a path it could
  hand back: the native side gives out opaque handles for those and accepts only them, so a file you didn't
  choose can't be read or written. It doesn't scan your disk for diagrams; the diagrams in a folder are found
  by listing that folder, to a limited depth and count, and reading names and dates only.
- **Its own data folder**: a small list of recent files and folders, its settings (what closing the window
  does), and recovery copies of work that isn't in a file yet (Quick Drafts, and unsaved changes to a file).
  The recovery copies are plain `.draftcanvas` text, like the file they'd become, so they're as private as
  any file in your user folder. They're removed when you save or discard.
- **A background image**, if the canvas has one, is written beside the `.draftcanvas` file, as the VS Code
  extension does.
- **AI agents, only if you turn them on** (Settings → AI agents, off by default). A coding agent on this
  computer can then list, read, create and change diagrams in the project folders you tick, and no others,
  through a connector that talks to the app over a user-only local socket or pipe. There is no network port.
  The app keeps a small request log (`agent/ledger.jsonl`: request ids, fingerprints, receipts and file
  paths, no diagram content) for 7 days so a retried request isn't applied twice. It also keeps a connection
  file with a random secret, which is removed when you turn access off. Draft Canvas sends nothing anywhere,
  but **your agent sends whatever it reads or writes to its own AI provider**, as it does with your code.
  See [Agent integration](agent-integration.md#security).

It asks for no special permission, and it doesn't watch your keyboard, mouse, screen, other apps or meetings.
While its window is hidden in the menu bar or tray it does nothing at all, unless you turned on AI agents, in
which case it answers their requests. A link in the app (About, for
example) opens in your browser, and only `http`, `https` and `mailto` links are ever passed on.

The installers are unsigned: see [Draft Canvas Desktop](../guides/desktop.md#releasing) for what your operating
system will say the first time, and how to check a download against its published checksum.

## What this does not protect you from

Being honest about the limits:

- **Clearing your browser's site data deletes your diagrams.** So does "clear cookies and site
  data" for this origin, and some privacy extensions do it automatically. Export a `.draftcanvas`
  file for anything you would be upset to lose.
- **Diagrams are per-browser and per-device.** A diagram made in Chrome is not in Safari, and not
  on your other laptop. Moving one means exporting and importing it.
- **Private windows usually discard storage** when the window closes.
- **Diagrams are stored as plain records** since 2.0. Builds from 1.0 to 1.11 encrypted them with a
  key kept in the same browser profile, which protected the stored bytes against a copy made without
  that key and against little else, while making saving impossible over plain `http://` and losing
  every diagram if only the key store was lost. Rows saved by those builds stay readable and are
  rewritten plain when next saved. See [`SECURITY.md`](../../SECURITY.md#browser-storage) for the
  reasoning, and use a `.dcenc` export for a diagram that needs protecting at rest.
- **Storage quotas are finite.** If the browser runs out of space the app tells you and keeps the
  document in memory so you can export it.

## Verifying it yourself

```bash
npm test                      # includes the privacy assertions
grep -rn "fetch\|XMLHttpRequest\|WebSocket\|sendBeacon" src/
```

Or open the network tab, draw for a while, and watch nothing happen.
