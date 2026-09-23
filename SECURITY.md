# Security

Draft Canvas has no backend, so most of the usual questions ("is your API rate-limited," "how do
you rotate credentials") don't apply. What's left is the local encryption model, and this document
is the honest account of what it does and doesn't do. See also [`docs/reference/privacy.md`](docs/reference/privacy.md)
for what's stored and what leaves the machine (nothing), and
[`docs/reference/architecture.md`](docs/reference/architecture.md#persistence-and-the-crypto-boundary) for the module boundary.

## Threat model

**In scope — what encryption-at-rest protects against:**

- Someone inspecting IndexedDB files directly (e.g. reading the browser profile's on-disk storage
  without going through the browser itself).
- A stolen or copied device/disk image, where the attacker has the files but not a running,
  unlocked instance of the browser as you.
- Casual browsing of local storage through devtools or a file manager — a diagram's contents, not
  its title (see the `documents`/`bodies` split in `docs/reference/privacy.md`), never appear as plaintext.

**Out of scope — what it does not protect against:**

- A compromised operating system, browser, or browser extension. Any of these can run as you, and
  running as you is sufficient to read your diagrams — the same as any other locally-stored,
  locally-encrypted data with no separate password gate.
- XSS in the page itself. There is no user-generated code execution surface by design (node text
  and code cards are rendered as data, never as markup or script — see `docs/reference/architecture.md`'s
  "one renderer" section), but this document does not claim zero-vulnerability, only zero-network.
- Memory inspection or a screenshot/screen-recording of an unlocked session. If you can see the
  diagram, so can anything with access to your screen.
- Multi-user protection on a shared, already-logged-in OS account. The encryption key is scoped to
  the browser profile, not to a person.

In short: this is encryption **at rest**, for data that is otherwise inert on disk — not a
password gate on the running application, and not a defense against a compromised device.

## Key lifecycle

- **One key, generated locally, on first use.** `crypto.subtle.generateKey` produces a
  non-extractable AES-256-GCM key the first time the app needs one. Non-extractable means no code —
  not a browser extension, not a compromised dependency, not Draft Canvas itself — can ever read the
  raw key bytes back out through the Web Crypto API; only `encrypt`/`decrypt` calls are possible.
- **Stored by the browser, not by Draft Canvas.** The key lives in its own IndexedDB object store,
  persisted via the browser's native structured-clone support for `CryptoKey` objects. Draft Canvas
  never sees, transmits, or backs up the key — there is no server for it to go to.
- **Scoped to one browser profile.** Clearing that profile's site data, using a different browser,
  or a different device all mean a different key (or no key yet) — see the "moves and doesn't
  move" note below.
- **No rotation, no expiry.** A single long-lived key is the model; nothing here doubles as a
  password you're expected to change periodically.

### What this means for moving or losing data

- **A diagram encrypted under one profile's key cannot be decrypted by another profile, browser, or
  device.** This is not a bug to route around — it's the reason exporting matters. A
  `.draftcanvas` or `.dcenc` file is portable precisely because it's decrypted (or
  passphrase-decryptable) independently of any browser's local key.
- **If the local key is lost — a cleared profile, a wiped device — everything still encrypted only
  in IndexedDB is unrecoverable.** There is no recovery mechanism, no backup key, and no support
  channel that can get it back, by design: a recovery path is a second way in, and a second way in
  is a second thing to secure. This is the same tradeoff privacy-focused local-first tools make
  generally — export anything you would be upset to lose.

## Passphrase-protected export (`.dcenc`)

The portable, share-anywhere alternative to a plain `.draftcanvas` file:

- **Independent key material.** Exporting derives a one-off AES-256-GCM key from the passphrase you
  type (PBKDF2-HMAC-SHA256, ≥600,000 iterations, a fresh random 16-byte salt per file). That key is
  used only to encrypt the one export payload and is never persisted anywhere, and it shares no
  material with the profile's local storage key — a `.dcenc` passphrase can never become, or leak,
  the key protecting everything already saved on this device.
- **The iteration count travels with the file.** A future default increase to the PBKDF2 work
  factor doesn't break importing files exported under an older default — the envelope records what
  was actually used.
- **No recovery.** Forgetting the passphrase makes the file permanently unreadable — Draft Canvas
  never sees or stores it, so there is nothing to reset.
- **Choosing a passphrase.** Treat it like any other passphrase protecting something you can't
  recover: long enough to resist offline guessing (the export UI enforces a minimum length, not a
  ceiling), and not reused from somewhere its compromise would also expose the diagram.
- **Importing** decrypts locally, authenticates the ciphertext (a wrong passphrase or corrupted
  file fails cleanly, not silently), and only then feeds the result through the same
  untrusted-input validator every import goes through — a `.dcenc` file gets no more trust than a
  plain one once it's decrypted.

## Beyond the browser

The encryption above is how the **web app** stores diagrams in the browser. The other ways to run
Draft Canvas store them differently, and have their own trust boundaries:

- **Desktop** (`src-tauri/`) keeps each diagram as a plain `.draftcanvas` file where you save it, plus
  plain recovery copies of unsaved work in its own data folder — as private as any file in your user
  folder, and no more; there is no encryption at rest. The native side hands the editor opaque handles
  rather than paths, so it can only read or write files you chose. It checks this project's GitHub
  releases for updates, and installs an update only if its signature matches the public key built into
  the app (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`). The installers themselves are not
  code-signed or notarized; verify a download against the release's `SHA256SUMS.txt` and build
  attestation. Details: [privacy](docs/reference/privacy.md#the-desktop-app) and
  [Desktop updates](docs/reference/desktop-updates.md).
- **VS Code** (`vscode-extension/`) doesn't bundle the editor: it frames the hosted one from
  `acltabontabon.com` and hands it one file over `postMessage`. So the code editing your file is what
  that site serves at the time, and it changes only on a Draft Canvas release. The file is plain JSON,
  written by VS Code.
- **Docker** serves the same static web app, so the browser threat model above applies. Serve it over
  HTTPS: browsers only allow the Web Crypto encryption on HTTPS or `localhost`.

## Supported versions

Fixes, security fixes included, ship in the next release; older versions don't get backports.

| Distribution | Supported |
| --- | --- |
| Web app (hosted), Docker image, Desktop | The latest `vX.Y.Z` release. They share one version and ship together. |
| Desktop previews (`desktop-vX.Y.Z-alpha.N`) | Only until the next alpha or the release it leads to |
| VS Code extension | The latest `extension-vX.Y.Z` release on the Marketplace |

## Reporting a concern

There's no bug bounty program or dedicated security contact — this is a small, local-first tool,
not a service with a security team. For a genuine vulnerability (not a threat-model limitation
already listed above) — including an accidental secret exposure, unsafe import/export behavior, or
a local data/privacy issue — the preferred path is GitHub's private vulnerability reporting: on this
repository, go to the **Security** tab → **Report a vulnerability**. That reaches the maintainer
directly without a public issue. If you can't use that, open a regular issue that asks for a private
channel — without any details of the problem — and the maintainer will follow up. Either way, there's
no formal SLA — this is maintained by one person, not a team, so response time is best-effort.
