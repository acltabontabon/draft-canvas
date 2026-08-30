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

### localStorage

One key, `draft-canvas.theme`, holding `dark` or `light`.

All access goes through `src/lib/preferences.ts`, which namespaces keys and rejects any value
longer than 64 characters. No canvas content is written there, and a test
(`tests/privacy.test.ts`) fails the build if any other module touches web storage directly.

### In memory only

The undo/redo history, the clipboard, the current selection, and Explain Mode state. None of it
is persisted anywhere; closing the tab discards it.

## What leaves your machine

Nothing.

Draft Canvas makes **no network requests at all** once the page has loaded. There is no backend,
no API, no analytics endpoint, and no error reporting.

Three independent mechanisms keep it that way:

1. **No network code exists.** `tests/privacy.test.ts` walks every file in `src/` and fails if it
   finds `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `importScripts`, or a
   dynamic import of a remote URL. The same test fails on `eval` or the `Function` constructor.

2. **The browser enforces it.** The production build ships this Content Security Policy:

   ```
   default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; font-src 'self'; connect-src 'none';
   form-action 'none'; base-uri 'self'; object-src 'none'
   ```

   `connect-src 'none'` means the browser blocks every outbound request, including any a
   dependency might attempt. It is injected at build time only — the same directive would block
   Vite's hot-reload socket during development.

3. **A browser test asserts it.** `e2e/critical-journey.spec.ts` builds a diagram containing a
   deliberately sensitive label and asserts that no request carrying a body is ever made.

### Fonts

System font stacks only. No webfont is fetched, which is also why an exported PNG renders in the
right typeface.

### Exports

`.draftcanvas`, PNG and SVG files are generated in the page and handed to the browser's download
mechanism. No file passes through a server. What happens to a file after you save it is, of
course, up to you.

### Imports

Reading a file uses the `File` API on a file you chose. Nothing is uploaded. Imported files are
treated as untrusted: validated, repaired, and capped before anything reaches the canvas
(`src/document/validate.ts`).

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
  can too.
- **Storage quotas are finite.** If the browser runs out of space the app tells you and keeps the
  document in memory so you can export it.

## Verifying it yourself

```bash
npm test                      # includes the privacy assertions
grep -rn "fetch\|XMLHttpRequest\|WebSocket\|sendBeacon" src/
```

Or open the network tab, draw for a while, and watch nothing happen.
