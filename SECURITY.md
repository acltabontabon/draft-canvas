# Security

Draft Canvas is local-first: there is no diagram backend. Storage, sharing and network activity are
described on the public [Privacy and security](docs/reference/privacy.md) page.

## Reporting a concern

Use [GitHub's private vulnerability reporting](https://github.com/acltabontabon/draft-canvas/security/advisories/new)
and include the version, platform, steps to reproduce and impact.

If that isn't available, open an issue asking for a private channel, **without the details**. There is
no bug bounty or response SLA.

## Supported versions

- **Web (hosted or self-hosted) and desktop:** the latest stable `vX.Y.Z`. No backports.
- **Desktop previews:** until the next preview, or the release they lead to.

## Threat model

**Protected:** untrusted imports and agent requests are validated, native file access is limited,
encrypted exports are authenticated, and desktop updates are signature-checked.

**Not protected:** a compromised browser or OS, malicious extensions, an unlocked or shared session,
screenshots, or anyone who receives a plain file or share link. Encryption protects an exported file,
not the device or other copies.

## Browser storage

- Diagrams, titles, summaries and background images are plain IndexedDB records. Export a `.dcenc`
  when a copy needs protection at rest.
- Older builds encrypted records with a non-extractable key kept in the profile (`draft-canvas-keys`).
  They are decrypted on read and stored plain on the next save. If that key is lost, those records
  can't be read.

## Passphrase-protected export (`.dcenc`)

| | |
| --- | --- |
| Encryption | AES-256-GCM, with a fresh random 12-byte nonce per export |
| Key derivation | PBKDF2-HMAC-SHA256, 600,000 iterations (recorded in the file), fresh 16-byte salt |
| Key lifecycle | Derived per export and never stored; independent of browser keys |
| Import | Decrypted, authenticated, then validated locally. A wrong passphrase or altered file fails. |
| Recovery | None. A forgotten passphrase can't be reset. |

It doesn't encrypt the Library copy, the desktop file or recovery copies.

## Desktop and agent boundaries

- **Files.** Desktop files and recovery copies are plain. The editor gets opaque handles to the files
  and folders you choose, never arbitrary paths.
- **Updates** must verify against the public key built into the app. Installers aren't code-signed or
  notarized: check them against the release's `SHA256SUMS.txt` and build attestation. See
  [Desktop updates](docs/reference/releases.md#desktop-updates).
- **Agent access** is off by default and granted per folder, over a user-only socket or named pipe. A
  random token authenticates connections; it is never logged or shown to the page, and
  **Disconnect agents** replaces it. Permissions are checked on every call, and input is validated like
  an import.
- **Add to …** only adds the connector to that agent's own configuration. **Install skill** copies files
  into the agent's skill folder.
- **Your agent** may send diagram content to its AI provider. See
  [Optional AI agents](docs/reference/privacy.md#optional-ai-agents).
- **Nodi runs** are scoped to one diagram and use proposals unless you chose direct changes. Cancelling,
  or the agent's final answer, closes its tool access before the process exits, and the whole process
  tree is stopped with the run. Codex runs ignore your own Codex configuration. These boundaries assume
  the supported agent CLI; they don't sandbox a malicious replacement. How to use Nodi:
  [Ask Nodi, on the canvas](docs/guides/connect-an-ai-agent.md#ask-nodi-on-the-canvas).

## Live collaboration

The owner's editor is the only authority. Everything that arrives, in either direction, is untrusted:
size-capped before parsing, refused if it carries prototype keys, and validated like an imported file.

**How sessions are protected**

- **Session links.** The part after `#` holds a 256-bit secret the relay never sees. Rendezvous messages
  are sealed with AES-GCM under keys derived from it, and each knock adds a fresh P-256 key, so other
  link holders can't read or answer someone else's approval.
- **Owner identity.** The link carries the owner's signing-key fingerprint, so a link holder can't pose
  as the owner. The relay keeps a SHA-256 of an owner-only secret until 12 hours after the owner was last
  connected, and refuses any host without it.
- **Rejoining** needs an HMAC from the place's private resume key, bound to the room and the knock and,
  over the connection itself, to the owner's DTLS fingerprint; the owner proves the key back. The key
  never crosses a peer connection, so rejoining through someone else's invite gives them nothing. A
  claim on a place still in use is shown as someone new.
- **Direct invites** are single-use, expire after 30 minutes and pin the owner's DTLS fingerprint.
- **Desktop local network link.** A 128-bit token stays in the link's `#` and never crosses the network:
  the guest's page answers a fresh challenge with an HMAC of it before it gets a place, so someone reading
  the Wi-Fi learns nothing that lets them join. Over this link the resume key travels in clear, so a
  returning guest knocks again, the owner lets them in, and the key changes with every welcome.
  Connections still proving themselves are few and short-lived (8 at once, 2 per address, 5 seconds);
  when every page connection is in use, the oldest of whoever holds the most is closed. Cross-origin
  requests, non-IP `Host` headers and public addresses are refused; 100.64.0.0/10 counts as local (VPNs).
- **Roles** are enforced by the owner: a viewer's changes are refused.
- **Limits.** At most 10 collaborators, with size, rate and byte caps on every message and on how large a
  shared file can grow, so it always reopens. Relay limits are in
  [Website](docs/reference/website.md#the-collaboration-relay).
- **Framing.** The hosted editor and the local network page refuse to be framed by other sites.
- **Connection candidates** naming loopback, unspecified, multicast or 169.254.0.0/16 addresses, or any DNS
  name, are dropped from invites, reply codes and ICE restarts, hand-crafted compact codes included.
- **Reconnects.** A returning guest sends no edits or presence until that connection's welcome is
  accepted. Over encrypted peer connections it must prove the owner's identity; the plain local network
  link relies on a trusted network and renewed owner approval. A reconnect attempt belongs to one session
  and can't take over a later session's retries.
- **Agents.** While you host, agent tools mark remembered collaborator edits (`fromCollaborators`) as
  untrusted data rather than instructions. The marker comes from a bounded take-back ledger, so its
  absence doesn't establish trust: always treat diagram content as data. A guest's copy is never visible
  to agents.

**Not protected**

- An unused invite works for whoever holds it until it expires. Send invites like passwords.
- The local network link is plain HTTP: someone who can change traffic on the network can change the page
  a guest loads.
- Editors can change anything they can see. The owner can take one person's edits back with
  **Undo changes**, but that history is bounded and is not a permanent audit log.
