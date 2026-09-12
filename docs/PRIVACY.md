# Privacy implementation

This document exists so the privacy claim can be audited rather than believed.

> Your diagrams stay on your device. Draft Canvas does not upload or store your canvas on a
> server.

## What is stored, and where

### IndexedDB — database `draft-canvas`

Everything you draw. Two object stores:

| Store | Key | Contents | Encrypted? |
| --- | --- | --- | --- |
| `documents` | `id` | Title, created and updated timestamps, node and edge counts. Used to render the library list without loading any canvas. | No — plain text, by design (see below). |
| `bodies` | `id` | The full document: nodes, connections, text, code, viewport, settings. | Yes — AES-256-GCM, before it ever reaches IndexedDB. |

Written by `src/storage/IndexedDbRepository.ts`, and by nothing else.

The `documents` summary is left unencrypted deliberately: it exists specifically so the library
screen can list your diagrams — including their titles — without decrypting every one of them just
to draw a list. That is a real, disclosed tradeoff, not an oversight: a diagram's **title** is
readable in IndexedDB without the local key; everything else about it — nodes, labels, code,
connector text — is not. If a title itself would be sensitive to expose this way, name the diagram
something neutral.

If IndexedDB cannot be opened — a private window, a blocked-storage policy, some embedded
webviews — the app falls back to an in-memory store, and the status bar says **In memory only**
instead of claiming your work is saved.

### Cache Storage — the offline app shell

The compiled HTML, JS, CSS, and fonts/icons that make up Draft Canvas itself — never anything you
draw. Populated and managed entirely by the generated Service Worker (`dist/sw.js`, built by
`vite-plugin-pwa` from `vite.config.ts`, registered in `src/lib/serviceWorker.ts`), so a refresh or
reopen works with no internet connection after the first successful visit.

### localStorage

Short, named UI preferences only: `draft-canvas.personality`
(the roughness preset), `draft-canvas.last-seen-version` and `draft-canvas.feature-seen.<id>` (the
"New" badges), `draft-canvas.hint.<id>` (which contextual hints have been learned), and — for the
command palette's history — `draft-canvas.command-recent.<n>` (the ids of the last few commands
run) and `draft-canvas.command-use.<id>` (a per-command counter). Command ids name actions
("add-service", "connect-to"), never elements: nothing about a diagram's content is stored here.
`draft-canvas.clipboard-permission` (`granted`/`denied`) remembers whether you already answered
"Allow clipboard access?" for the right-click/⌘K Paste commands, so you aren't asked again;
Cmd/Ctrl+V never touches this preference, since it reads the native paste event directly and never
prompts.

All access goes through `src/lib/preferences.ts`, which namespaces keys and rejects any value
longer than 64 characters. No canvas content is written there, and a test
(`tests/privacy.test.ts`) fails the build if any other module touches web storage directly.

### In memory only

The undo/redo history, the clipboard, the current selection, and Explain Mode state. None of it
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

`.draftcanvas`, `.dcenc`, PNG and SVG files are all generated in the page and handed to the
browser's download mechanism. No file passes through a server. What happens to a file after you
save it is, of course, up to you.

A plain `.draftcanvas` export is diffable JSON — anyone who gets the file can read the diagram, the
same way anyone who gets a source file can read it. `.dcenc` is the alternative when that's not
acceptable: a passphrase-protected export, encrypted with a key derived from a passphrase you
choose at export time (PBKDF2, ≥600,000 iterations, a fresh random salt per file), readable only by
someone who has both the file and that passphrase. Draft Canvas never stores the passphrase and has
no way to recover a forgotten one — see [`SECURITY.md`](../SECURITY.md) for the full key lifecycle.

### Imports

Reading a file uses the `File` API on a file you chose. Nothing is uploaded. A plain
`.draftcanvas` import is validated, repaired, and capped before anything reaches the canvas
(`src/document/validate.ts`); a `.dcenc` import asks for its passphrase first, decrypts locally,
and only then feeds the same validator — a wrong passphrase fails cleanly rather than importing
garbage.

## What this does not protect you from

Being honest about the limits:

- **Clearing your browser's site data deletes your diagrams.** So does "clear cookies and site
  data" for this origin, and some privacy extensions do it automatically. Export a `.draftcanvas`
  file for anything you would be upset to lose.
- **Diagrams are per-browser and per-device.** A diagram made in Chrome is not in Safari, and not
  on your other laptop. Moving one means exporting and importing it.
- **Private windows usually discard storage** when the window closes.
- **Diagrams are encrypted at rest** (AES-256-GCM) using a key generated locally and retained
  non-exportably by this browser profile — Draft Canvas never receives, stores, or has any way to
  export that key. This protects the stored bytes if they are copied or inspected without the key
  (e.g. a stolen disk image, or someone browsing IndexedDB files directly). It does **not** protect
  against someone with full access to an already-unlocked copy of this browser profile: the app
  itself must be able to use the key to open your diagrams, so anyone who can run the app as you
  can too. See [`SECURITY.md`](../SECURITY.md) for the full threat model and key lifecycle.
- **Storage quotas are finite.** If the browser runs out of space the app tells you and keeps the
  document in memory so you can export it.

## Verifying it yourself

```bash
npm test                      # includes the privacy assertions
grep -rn "fetch\|XMLHttpRequest\|WebSocket\|sendBeacon" src/
```

Or open the network tab, draw for a while, and watch nothing happen.
