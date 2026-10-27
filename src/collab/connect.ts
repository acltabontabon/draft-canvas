/**
 * How the rest of the app opens a collaboration connection — the one door into `collab/transport/`,
 * which nothing outside `collab/` may import (`tests/privacy.test.ts`). The interface asks for an
 * invite or answers one; it never touches a peer connection itself.
 */
import { MAX_GUEST_MESSAGE_BYTES } from './protocol';
import { CollabCodeError, decodeInvite, invitePayloadFromHash, inviteFragment, INVITE_LIFETIME_MS } from './transport/invite';
import type { IceConfig } from './transport/types';
import { createHostOffer, joinFromInvite, peerConnectionsAvailable, type HostOffer, type JoinResult } from './transport/webrtc';

export type { CollabTransport, TransportState } from './transport/types';
export type { HostOffer, JoinResult };
export { CollabCodeError, invitePayloadFromHash, INVITE_LIFETIME_MS, peerConnectionsAvailable };

/**
 * The public STUN server used to find a route between two networks, unless the person turns it off
 * or names their own. A STUN server learns the address it is asked from — never anything sent over
 * the connection, which is end-to-end encrypted between the two browsers.
 */
export const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';

export interface ConnectionPreferences {
  /** Only connect within the local network: no STUN, so no third party is asked anything. */
  localOnly: boolean;
  /** The person's own STUN server (`stun:host:port`); blank uses `DEFAULT_STUN`. */
  server: string;
}

/** The STUN server to ask, or none. Only a `stun:`/`stuns:` URL is accepted; anything else falls back. */
export function iceConfig(preferences: ConnectionPreferences): IceConfig {
  if (preferences.localOnly) return { servers: [], localOnly: true };
  const own = preferences.server.trim();
  const url = /^stuns?:[^\s/]+$/i.test(own) && own.length <= 64 ? own : DEFAULT_STUN;
  return { servers: [{ urls: url }], localOnly: false };
}

/**
 * How a collaborator connects to the invite `payload`, decided by the owner rather than by them: the
 * owner's offer carries a public (server-reflexive or relayed) candidate only when the owner asked a
 * STUN server, which is their "Anyone with the link". Then the collaborator asks one too — `server`, their
 * own if they set one, or `DEFAULT_STUN` — or the two browsers can't meet across networks. Otherwise
 * the owner chose "Only my network" (or their STUN server didn't answer), and the collaborator
 * asks no one either, so the owner's "nothing leaves your network" holds for everyone in the session.
 *
 * A payload that can't be read gets "this network only": joining it fails anyway, with the reason.
 */
export function followOwner(payload: string, server: string): IceConfig {
  let across = false;
  try {
    across = decodeInvite(payload).offer.candidates.some((candidate) => candidate.type !== 'host');
  } catch {
    // Read again, and refused with a proper message, by `joinFromInvite`.
  }
  return iceConfig({ localOnly: !across, server });
}

/**
 * Where knocks are relayed (`__COLLAB_RELAY__`, set at build time), or `null` when this build has
 * none — then only direct invites work. Only `ws:`/`wss:` addresses count.
 */
export function relayUrl(): string | null {
  const url = typeof __COLLAB_RELAY__ === 'string' ? __COLLAB_RELAY__.trim() : '';
  return /^wss?:\/\/[^\s]+$/.test(url) ? url : null;
}

/** A new invite for one person: its link, and where to paste their reply. */
export function createInvite(preferences: ConnectionPreferences): Promise<HostOffer> {
  return createHostOffer(iceConfig(preferences), { maxMessageBytes: MAX_GUEST_MESSAGE_BYTES });
}

/**
 * The invite link for `offer`, on the web app this page was loaded from — or, from the desktop app,
 * on the public web app, since an invite opens in the collaborator's browser.
 */
export function inviteLink(offer: HostOffer, base: string): string {
  const url = new URL(base);
  url.hash = inviteFragment(offer.invitePayload);
  return url.toString();
}

/**
 * Answers an invite: the reply code to send back, and the connection once the owner pastes it. Asks
 * a STUN server only if the owner did (`followOwner`); `server` is the collaborator's own, if any.
 */
export function answerInvite(payload: string, server: string): Promise<JoinResult> {
  return joinFromInvite(payload, followOwner(payload, server));
}
