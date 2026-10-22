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

## Live collaboration

The owner's editor is the only authority over a shared diagram. Every change a collaborator sends is
read as untrusted input: messages are size-capped before parsing, keys like `__proto__` are refused,
and each element goes through the same validation as an imported file, against the document's
limits, before it is applied. Collaborators check everything from the owner the same way — a
modified owner can't make a collaborator's copy write into their own Library, and can't send content
the editor would not accept from a file.

- **Knocking.** A session link's fragment holds a 256-bit secret the relay never receives; every
  rendezvous message is AES-GCM sealed under a key derived from it, with its direction bound in, so the
  relay sees only ciphertext and can't forge or reflect messages. Each knock carries a fresh P-256 key,
  and the owner's connection offer and the joiner's answer are sealed again under the key those two
  derive — another link holder watching the room can't read or answer an approval meant for someone
  else. The link also carries the fingerprint of a signing key the owner made for the session; the
  owner signs every greeting, and a knocker trusts none from any other key, so a link holder who reaches
  the relay as the room's host while the owner is away can't pose as the owner, offer a connection,
  turn anyone away or end the session. The owner decides every entry — by session link or by the
  desktop's local network link alike. A collaborator coming back after a dropped connection is let
  straight back in only with an HMAC, keyed with their place's private resume key, over this room and
  that knock's fresh key — so it can't be forged without the key or replayed into another knock. The
  relay limits sockets per room, message size and rate per socket, and new connections per client
  address (60 a minute). The greeting's signature covers the owner's name too. The only thing it stores is,
  per room and for at most 12 hours, the SHA-256 of an owner-only secret presented in the WebSocket
  handshake (never in the link or URL): any later host connection must present the same secret, so
  a link holder can't take or hold the owner's place.
- **Who may connect.** A direct WebRTC invite is single-use, bound to one reply by a random nonce, and
  expires after 30 minutes; the connection's DTLS fingerprint travels in the invite, so the reply can
  only connect to the owner who made it. A desktop local network session requires a 128-bit token,
  compared in constant time, rejects cross-origin and non-IP `Host` requests (DNS rebinding), and
  closes connections from outside the local network — public IPv4 and global IPv6 addresses — before
  reading anything. The shared-address range 100.64.0.0/10 counts as local, because VPN overlays such
  as Tailscale use it; on a carrier that hands those addresses out directly, other subscribers could
  reach the link — they still need the token, and the owner still decides who comes in. Guest
  messages are capped at 4 MB, with per-connection byte and message budgets checked as they are read.
- **What each may do.** Roles are enforced by the owner: a viewer's patches are refused, whatever
  their copy sends. Reclaiming a dropped place needs that place's private resume key, so knowing someone's
  peer id is not enough to become them; a re-invite gives back exactly one place.
- **Abuse limits.** At most 10 collaborators; per-connection rate and byte budgets, checked before a
  message is parsed; 4 MB per message from a collaborator (16 MB from the owner); one element named
  once per patch, and one id per element across the whole file; unreadable connections are closed;
  silent ones time out. A collaborator re-checks every commit and starts again from a fresh copy if
  one would leave the file inconsistent, and resends unsent edits only to the session they came from.
- **Not protected.** Anyone holding an unused invite can use it until it expires — send invites like
  passwords. The desktop local network link is plain HTTP on your network. People you let edit can
  change or delete anything they can see. Their edits don't enter the owner's undo history (undo takes
  back only one's own work), so the owner has **Restore to session start**, itself undoable.

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
