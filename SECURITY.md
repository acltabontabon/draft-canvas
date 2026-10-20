# Security

Draft Canvas is local-first, with no diagram backend. See [Privacy](docs/reference/privacy.md)
for storage locations, sharing and network activity.

## Threat model

The app validates untrusted imports and agent requests, limits native file access, authenticates
encrypted exports and verifies desktop update signatures.

It does not protect against a compromised browser or OS, malicious extensions with access to the
app, an unlocked/shared user session, screenshots, or someone receiving a plain file or share link.
Anyone able to run the app as you can read its open content and use any legacy storage key.
Encryption protects an exported file, not the device or the original diagram copies.

## Browser storage

Diagrams are **plain IndexedDB records since 1.12**. Titles, summaries and background images are
also unencrypted. Use a `.dcenc` export when a portable copy needs protection at rest.

Builds 1.0–1.11 encrypted diagram bodies using a non-extractable AES-256-GCM `CryptoKey` stored in
`draft-canvas-keys` in the same browser profile. That protected a body-only database dump without
the key, but not a copied profile or compromised session. It also required a secure context and
made losing the key store a whole-library loss risk, so encryption was retired for new writes.

Legacy rows remain encrypted until next saved and are still read with the existing key. Opening or
upgrading does not rewrite them, and no replacement key is generated. If the key is lost, recover
from another readable copy or an export; Draft Canvas cannot reconstruct it.

## Passphrase-protected export (`.dcenc`)

- **Encryption:** AES-256-GCM with a fresh random 12-byte nonce per export.
- **Key derivation:** PBKDF2-HMAC-SHA256, currently 600,000 iterations, with a fresh random 16-byte
  salt per file. The iteration count is recorded in the envelope for compatibility with future defaults.
- **Key lifecycle:** the derived key is used for that export only and is not persisted. It is
  independent of legacy browser keys; the passphrase is not stored.
- **Import:** decrypt and authenticate locally, then validate the resulting document. A wrong
  passphrase or altered ciphertext fails instead of importing unauthenticated data.
- **Recovery:** forgotten passphrases cannot be reset or recovered. Choose a long, unique passphrase.

An encrypted export does not encrypt or remove the browser record, desktop file or recovery copies.

## Desktop and agent boundaries

Desktop diagrams and recovery copies are plain files. The native shell grants the editor opaque
handles for chosen files and folders rather than arbitrary paths.

Update signatures are verified against the public key built into the app. Installers are not
code-signed or notarized; check downloads against the release's `SHA256SUMS.txt` and build attestation.
See [Desktop updates](docs/reference/desktop-updates.md) for signing and key lifecycle.

Agent access is off by default and granted per project folder. Its connector uses a user-only local
socket or named pipe, not a network port. Connections authenticate with a random token that is not
logged or exposed to the editor page; **Disconnect agents** replaces it and ends open connections.
Folder permissions are checked on every call and retry, and input is validated like an imported file.
Diagrams reachable through overlapping folders are refused as ambiguous, and queued reads stay bound
to the diagram they targeted. The request history that makes retries safe is bounded and expires.
**Add to Codex**, **Add to Claude Code**, **Add to Gemini CLI** and **Add to Junie** only add the
connector entry to that agent's own configuration; installing the bundled skill copies files into the agent's skill folder.
Your agent may send diagram content to its own AI provider; that provider is outside Draft Canvas's
control. See [Agent security](docs/reference/agent-integration.md#security).

Static self-hosting serves the same web app and uses browser storage. HTTPS enables its offline cache;
ordinary saving also works over HTTP.

## Supported versions

- **Web (hosted or self-hosted) and desktop:** the latest stable `vX.Y.Z` release; older releases get no backports.
- **Desktop previews:** supported until the next preview or the release they lead to.

## Reporting a concern

Report vulnerabilities privately through this repository's **Security → Report a vulnerability**.
Include the affected version/platform, reproduction steps and impact. This includes exposed secrets,
unsafe import/export behavior and local data or privacy vulnerabilities.

If private reporting is unavailable, open an issue requesting a private channel **without disclosing
the vulnerability details**. The maintainer will follow up. There is no bug bounty or formal response
SLA; responses are best-effort.
