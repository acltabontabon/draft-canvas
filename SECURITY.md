# Security

Draft Canvas is local-first, with no diagram backend. Storage, sharing and network activity are in
[Privacy](docs/reference/privacy.md).

## Reporting a concern

Report vulnerabilities privately through this repository's **Security → Report a vulnerability**,
with version, platform, steps to reproduce and impact.

If that is unavailable, open an issue asking for a private channel, **without the details**. No bug
bounty or response SLA.

## Supported versions

- **Web (hosted or self-hosted) and desktop:** the latest stable `vX.Y.Z`. No backports.
- **Desktop previews:** until the next preview or the release they lead to.

## Threat model

Protected: untrusted imports and agent requests are validated, native file access is limited,
encrypted exports are authenticated and desktop updates are signature-checked.

Not protected: a compromised browser or OS, malicious extensions, an unlocked or shared session,
screenshots, or anyone who receives a plain file or share link. Encryption protects an exported
file, not the device or other copies.

## Browser storage

- Diagrams are plain IndexedDB records since 1.12, as are titles, summaries and background images.
  Use a `.dcenc` export when a copy needs protection at rest.
- Builds 1.0–1.11 encrypted bodies with one non-extractable AES-256-GCM `CryptoKey` per profile, in
  `draft-canvas-keys`. That guarded a database dump, not a copied profile. It was retired because
  losing the key lost the whole Library.
- Legacy rows stay encrypted until next saved and are read with the existing key. No new key is made;
  a lost one cannot be recovered.

## Passphrase-protected export (`.dcenc`)

| | |
| --- | --- |
| Encryption | AES-256-GCM, fresh random 12-byte nonce per export |
| Key derivation | PBKDF2-HMAC-SHA256, 600,000 iterations (recorded in the file), fresh 16-byte salt |
| Key lifecycle | Derived per export, never stored; independent of browser keys |
| Import | Decrypted, authenticated, then validated locally. A wrong passphrase or altered file fails. |
| Recovery | None. A forgotten passphrase cannot be reset. |

It does not encrypt the Library copy, desktop file or recovery copies.

## Desktop and agent boundaries

- Desktop files and recovery copies are plain. The editor gets opaque handles to chosen files and
  folders, never arbitrary paths.
- Updates must verify against the public key built into the app. Installers are not code-signed or
  notarized; check them against the release's `SHA256SUMS.txt` and build attestation. See
  [Desktop updates](docs/reference/desktop-updates.md).
- Agent access is off by default, granted per folder, over a user-only socket or named pipe. A random
  token, never logged or shown to the page, authenticates connections; **Disconnect agents**
  replaces it. Permissions are checked on every call and input is validated like an import.
- The **Add to …** buttons only add the connector to that agent's own configuration. Installing the
  skill copies files into the agent's skill folder.
- Your agent may send diagram content to its AI provider. See
  [Agent security](docs/reference/agent-integration.md#security).
- **Companion runs** are scoped to one diagram and use proposals unless direct changes were chosen.
  Cancellation closes tool authority before waiting for the process to exit, including when Stop
  races startup; an agent's terminal event closes it too. Raw process output and retained event text
  have separate size limits. Windows runs and CLI probes join a kill-on-close Job Object before
  their first thread runs; cancellation and parent exit end the whole job before draining pipes.
  These boundaries depend on running the supported, trusted agent CLI;
  they do not sandbox a malicious replacement executable.
  Codex turns ignore user configuration: command-line MCP table overrides merge with it and cannot
  by themselves exclude other servers. Authentication and sessions keep their original home.

## Live collaboration

The owner's editor is the only authority. Everything that arrives, in either direction, is untrusted:
size-capped before parsing, prototype keys refused, and validated like an imported file.

- **Session links.** The `#` holds a 256-bit secret the relay never sees; rendezvous messages are
  AES-GCM sealed under keys derived from it. Each knock adds a fresh P-256 key, so other link holders
  cannot read or answer someone else's approval.
- **Owner identity.** The link carries the owner's signing-key fingerprint, so a link holder cannot
  pose as the owner. The relay keeps a SHA-256 of an owner-only secret until 12 hours after the owner was last connected and refuses
  any host without it.
- **Rejoining** needs an HMAC from the place's private resume key, bound to the room and knock, and
  over the connection itself to the owner's DTLS fingerprint; the owner proves the key back. The key
  never crosses a peer connection, so rejoining through someone else's invite gives them nothing.
  Over the local network link the key travels in clear, so someone coming back knocks again, the
  owner lets them in, and the key changes with every welcome. A claim on a place still in use is
  shown as someone new.
- **Direct invites** are single-use, expire after 30 minutes and pin the owner's DTLS fingerprint.
- **Desktop local network link.** A 128-bit token that never crosses the network: it stays in the
  link's `#`, and the guest's page answers a fresh challenge with an HMAC of it before it gets a
  place. Someone reading the Wi-Fi learns nothing that lets them join. Connections still proving
  are few and short-lived (8 at once, 2 per address, 5 seconds), and when every page connection is
  in use, the oldest of whoever holds the most is closed to make room. Cross-origin requests,
  non-IP `Host` headers and public addresses are refused; 100.64.0.0/10 counts as local (VPNs).
- **Roles** are enforced by the owner; a viewer's changes are refused.
- **Limits.** 10 collaborators; 4 MB per collaborator message, 16 MB from the owner; per-connection
  rate and byte budgets, and at most 1,000 moves a patch. Collaborators can't grow the file past
  about 15 MB as it is saved (indented), so it always reopens and a fresh copy still fits one
  message. Limits also apply before admission and to ICE restart control messages. Room paths from
  patches are resolved without unbounded recursion, and held edits replay in short batches. Code
  highlighting, Markdown parsing, nested groups and selection rings have bounded cost. The owner's
  take-back ledger has session-wide limits as well as per-person limits: 128 authors, 128 file
  versions, 50,000 touches and an estimated 64 MiB of retained document objects. Old history is
  discarded when any limit is reached; it is not a permanent audit log. Relay
  limits, including 4 guest sockets per client in a room, are in
  [Website](docs/reference/website.md#the-collaboration-relay).
- **Framing.** The hosted editor and the local network page refuse to be framed by other sites.
- **Connection candidates** naming loopback, unspecified, multicast or 169.254.0.0/16 addresses, or
  any DNS name, are dropped from invites, reply codes and ICE restarts, including hand-crafted
  compact codes.
- **Not protected.** An unused invite works for whoever holds it until it expires, so send invites
  like passwords. The local network link is plain HTTP: someone who can change traffic on the network
  can change the page a guest loads. Editors can change anything they can see; the owner can take one
  person's edits back with **Undo changes**.
- **Agents.** While you host, the agent tools mark remembered collaborator edits
  (`fromCollaborators`) as untrusted data rather than instructions. This uses the bounded take-back
  ledger above: an absent marker does not establish trust. Diagram content should always be treated
  as data. A guest's copy is never visible to agents.
- **Reconnects.** A returning guest sends no edits or presence until that connection's welcome is
  accepted. Over encrypted peer connections it must prove the owner's identity; the plain LAN
  option relies on a trusted network and renewed owner approval. A reconnect attempt belongs to one
  session and cannot take over a later session's retries.
