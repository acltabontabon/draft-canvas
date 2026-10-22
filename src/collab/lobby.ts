/**
 * The waiting room: someone opens the session link and knocks, the owner lets them in or not, and
 * the connection they then need is made without either of them copying anything.
 *
 * Both halves ride the relay (`transport/relay.ts`) with every message sealed (`rendezvous.ts`). The
 * owner's half keeps a list of knocks; letting one in prepares a WebRTC offer exactly as a direct
 * invite does (`connect.ts`), sends it sealed to that one knocker, and attaches the connection their
 * answer opens to the running session. The relay only ever carried what would otherwise have been
 * copied and pasted, unreadably.
 *
 * Someone coming back after a dropped connection knocks as "returning": if the place they name is
 * waiting for them, they are let back in without asking — and the session still makes them prove
 * the place is theirs with its private key before giving it back (`HostSession.attach`'s `requireKey`).
 */
import { followOwner, iceConfig, type ConnectionPreferences } from './connect';
import { MAX_GUEST_MESSAGE_BYTES, readName, type Role } from './protocol';
import {
  greetingStatement,
  newExchange,
  readToGuest,
  readToHost,
  returningProof,
  roomKey,
  sameSecret,
  seal,
  unseal,
  verifyOwner,
  toBase64Url,
  type Exchange,
  type OwnerIdentity,
  type SessionLink,
} from './rendezvous';
import { openRelay, type RelayChannel } from './transport/relay';
import type { CollabTransport } from './transport/types';
import { createHostOffer, joinFromInvite, type HostOffer } from './transport/webrtc';

/** Waits between attempts to get the waiting room back on the relay after its connection drops. */
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

/** Knocks waiting at once; more are turned away until some are answered. */
export const MAX_KNOCKS = 12;
/** How long a let-in knocker has to answer before the offer is withdrawn. */
export const ANSWER_TIMEOUT_MS = 60_000;

export interface Knocking {
  /** The relay's tag for their socket — how the owner addresses them. */
  id: string;
  /** As they typed it themselves. */
  name: string;
  at: number;
  /** Set while their connection is being made, after the owner let them in. */
  admitting?: Role;
}

export type LobbyStatus = 'connecting' | 'open' | 'unavailable';

export interface HostLobbyEvents {
  status(status: LobbyStatus): void;
  knocks(knocks: readonly Knocking[]): void;
  /** A knocker the owner let in is connected: attach them to the session. */
  admitted(transport: CollabTransport, role: Role, reuse?: string): void;
  /** Someone coming back: the role and private resume key of that place, if it is waiting for them. */
  isReturning(peerId: string): { role: Role; key: string } | null;
  failed(name: string, reason: string): void;
}

interface KnockState extends Knocking {
  publicKey: string;
  exchange?: Exchange;
  pair?: CryptoKey;
  offer?: HostOffer;
  timer?: ReturnType<typeof setTimeout>;
  returning?: string;
}

/** The owner's side: keeps the room open on the relay for as long as the session runs. */
export class HostLobby {
  private relay: RelayChannel | null = null;
  /** The owner's own secret on the relay — never in the link — so nobody else can host the room. */
  private readonly hostSecret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  private attempts = 0;
  private everOpen = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private key: CryptoKey | null = null;
  private readonly knocks = new Map<string, KnockState>();
  /** Knocks whose key exchange is still being worked out; they count toward the door's limit. */
  private readonly pendingKnocks = new Set<string>();
  private ended = false;
  private readonly link: SessionLink;
  private readonly identity: OwnerIdentity;
  private readonly relayUrl: string;
  private readonly owner: string;
  private readonly network: ConnectionPreferences;
  private readonly events: HostLobbyEvents;

  constructor(link: SessionLink, identity: OwnerIdentity, relayUrl: string, owner: string, network: ConnectionPreferences, events: HostLobbyEvents) {
    this.link = link;
    this.identity = identity;
    this.relayUrl = relayUrl;
    // Signed and sent as every knocker reads it back (`readName`), or the greeting never verifies.
    this.owner = readName(owner) ?? owner;
    this.network = network;
    this.events = events;
  }

  async open(): Promise<void> {
    this.events.status('connecting');
    try {
      this.key = await roomKey(this.link);
    } catch {
      return this.events.status('unavailable');
    }
    this.connect();
  }

  /**
   * Puts the room on the relay, and keeps it there: a dropped connection (a laptop waking, a network
   * change) is retried with growing waits for as long as the session runs. Knocks in flight are
   * forgotten on a drop; whoever was waiting knocks again when the relay says the owner is back.
   */
  private connect(): void {
    if (this.ended) return;
    let relay: RelayChannel;
    try {
      relay = openRelay(this.relayUrl, this.link.room, 'host', this.hostSecret);
    } catch {
      return this.events.status('unavailable');
    }
    this.relay = relay;
    relay.onState((state, reason) => {
      if (this.ended || this.relay !== relay) return;
      if (state === 'open') {
        this.attempts = 0;
        this.everOpen = true;
        this.events.status('open');
        return;
      }
      if (state !== 'closed') return;
      this.relay = null;
      for (const id of [...this.knocks.keys()]) this.forget(id);
      // Refused as not the owner: someone else's room, and nothing to retry.
      if (reason === 'not-owner') return this.events.status('unavailable');
      // Never reached yet: direct invites are the way in for now, while it keeps trying. Reached before:
      // it is only reconnecting, and the session link still works once it's back.
      this.events.status(this.everOpen ? 'connecting' : 'unavailable');
      const wait = RECONNECT_MS[Math.min(this.attempts, RECONNECT_MS.length - 1)]!;
      this.attempts += 1;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, wait);
    });
    relay.onEvent((event) => {
      if (this.ended || this.relay !== relay) return;
      // Whatever a malformed message makes fail stays here, never an unhandled rejection.
      if (event.kind === 'message') void this.receive(event.from, event.data).catch(() => this.forget(event.from));
      else if (event.kind === 'left') this.forget(event.from);
    });
  }

  list(): Knocking[] {
    return [...this.knocks.values()].map(({ id, name, at, admitting }) => ({ id, name, at, ...(admitting ? { admitting } : {}) }));
  }

  private changed(): void {
    this.events.knocks(this.list());
  }

  private async receive(from: string, data: string): Promise<void> {
    const message = readToHost(await unseal(this.key!, 'to-host', data));
    if (!message || this.ended) return;
    if (message.t === 'knock') {
      if (this.knocks.has(from) || this.pendingKnocks.has(from) || this.knocks.size + this.pendingKnocks.size >= MAX_KNOCKS) return;
      // The exchange is worked out before the knock takes a place at the door: a key that isn't a real
      // point on the curve fails here and leaves nothing behind (it could otherwise fill the door with
      // knocks nobody can see or answer).
      this.pendingKnocks.add(from);
      let exchange: Exchange;
      let pair: CryptoKey;
      let signature: string;
      try {
        exchange = await newExchange();
        pair = await exchange.pairWith(message.publicKey, this.link);
        signature = await this.identity.sign(greetingStatement(this.link, message.publicKey, exchange.publicKey, this.owner));
      } catch {
        return;
      } finally {
        this.pendingKnocks.delete(from);
      }
      if (this.ended || this.knocks.has(from)) return;
      const back = message.returning ? await this.returningRole(message.returning, message.publicKey) : null;
      const knock: KnockState = { id: from, name: message.name, at: Date.now(), publicKey: message.publicKey, exchange, pair };
      if (back && message.returning) knock.returning = message.returning.peer;
      this.knocks.set(from, knock);
      // Tell them they've been seen, and hand over this side of their private exchange — signed, so
      // they know it is the owner the link names and not someone else holding the link.
      this.relay?.send(
        from,
        await seal(this.key!, 'to-guest', { t: 'seen', owner: this.owner, publicKey: exchange.publicKey, ownerKey: this.identity.publicKey, signature }),
      );
      if (back) return this.allow(from, back);
      this.changed();
    } else if (message.t === 'answer') {
      const knock = this.knocks.get(from);
      if (!knock?.pair || !knock.offer) return;
      const opened = await unseal(knock.pair, 'to-host', message.box);
      const reply = typeof opened === 'object' && opened !== null ? (opened as { reply?: unknown }).reply : undefined;
      if (typeof reply !== 'string') return;
      const offer = knock.offer;
      const role = knock.admitting ?? 'editor';
      const reuse = knock.returning;
      // Off the door as soon as their answer is in: they are joining, not waiting.
      this.drop(from);
      this.changed();
      try {
        const transport = await offer.acceptReply(reply);
        if (this.ended) return transport.close('ended');
        this.events.admitted(transport, role, reuse);
      } catch {
        this.events.failed(knock.name, 'connect');
      }
    } else if (message.t === 'cancel') {
      this.forget(from);
    }
  }

  /**
   * The role to let a returning collaborator back in with, without asking — only when their place is
   * waiting and their proof was made with that place's private key for this very knock.
   */
  private async returningRole(returning: { peer: string; proof: string }, knockerKey: string): Promise<Role | null> {
    const place = this.events.isReturning(returning.peer);
    if (!place) return null;
    const expected = await returningProof(place.key, this.link, knockerKey);
    return sameSecret(expected, returning.proof) ? place.role : null;
  }

  /** Lets a knocker in with `role`: their connection is prepared and sent to them alone. */
  async allow(id: string, role: Role): Promise<void> {
    const knock = this.knocks.get(id);
    if (!knock?.pair || knock.admitting) return;
    knock.admitting = role;
    this.changed();
    try {
      const offer = await createHostOffer(iceConfig(this.network), { maxMessageBytes: MAX_GUEST_MESSAGE_BYTES });
      if (this.ended || this.knocks.get(id) !== knock) return offer.cancel();
      knock.offer = offer;
      const box = await seal(knock.pair, 'to-guest', { invite: offer.invitePayload });
      this.relay?.send(id, await seal(this.key!, 'to-guest', { t: 'offer', box }));
      knock.timer = setTimeout(() => {
        if (this.knocks.get(id) !== knock) return;
        this.events.failed(knock.name, 'timeout');
        this.forget(id);
      }, ANSWER_TIMEOUT_MS);
    } catch {
      this.events.failed(knock.name, 'offer');
      this.forget(id);
    }
  }

  async deny(id: string): Promise<void> {
    const knock = this.knocks.get(id);
    if (!knock) return;
    if (knock.pair) this.relay?.send(id, await this.closed(knock.pair, 'denied'));
    this.forget(id);
  }

  /** A refusal or an ending, sealed under that knocker's pair key: nobody else can say it to them. */
  private async closed(pair: CryptoKey, reason: 'denied' | 'ended'): Promise<string> {
    return seal(this.key!, 'to-guest', { t: 'closed', box: await seal(pair, 'to-guest', { reason }) });
  }

  /** Stops answering: anyone still waiting hears the session is over. */
  async close(): Promise<void> {
    if (this.ended) return;
    const waiting = [...this.knocks.values()];
    const relay = this.relay;
    this.ended = true;
    if (this.retry !== null) clearTimeout(this.retry);
    for (const knock of waiting) this.drop(knock.id);
    if (this.key && relay) {
      await Promise.all(waiting.map(async (knock) => (knock.pair ? relay.send(knock.id, await this.closed(knock.pair, 'ended')) : false)));
    }
    relay?.close();
  }

  private drop(id: string): void {
    const knock = this.knocks.get(id);
    if (!knock) return;
    if (knock.timer) clearTimeout(knock.timer);
    this.knocks.delete(id);
  }

  private forget(id: string): void {
    const knock = this.knocks.get(id);
    if (!knock) return;
    knock.offer?.cancel();
    this.drop(id);
    this.changed();
  }
}

/* ------------------------------------------------------------------ guest -- */

export type KnockStatus =
  | { kind: 'connecting' }
  /** At the door, but the owner isn't in the room. */
  | { kind: 'no-owner' }
  /** The owner has seen the knock; waiting for them. */
  | { kind: 'waiting'; owner: string }
  /** Let in: the connection is being made. */
  | { kind: 'joining'; owner: string }
  | { kind: 'denied' }
  | { kind: 'ended' }
  | { kind: 'unavailable' };

/**
 * Knocks once and waits. Resolves with the connection when the owner lets this person in; the status
 * callback says what is happening meanwhile, for the join dialog to show.
 */
export async function knock(
  link: SessionLink,
  relayUrl: string,
  person: { name: string; returning?: { peer: string; key: string } },
  /** The collaborator's own STUN server, if they set one; whether to ask one at all is the owner's call. */
  stunServer: string,
  onStatus: (status: KnockStatus) => void,
): Promise<{ transport: Promise<CollabTransport | null>; cancel(): void }> {
  const name = readName(person.name);
  if (!name) throw new Error('A name is needed to knock.');
  const key = await roomKey(link);
  const exchange = await newExchange();
  const relay = openRelay(relayUrl, link.room, 'guest');
  let pair: CryptoKey | null = null;
  let owner = '';
  let knocked = false;
  let settled = false;
  /** Answering an offer: the connection settles it now, not the relay (the owner may already be opening it). */
  let joining = false;
  let cancelJoin: (() => void) | null = null;
  let resolve!: (transport: CollabTransport | null) => void;
  const transport = new Promise<CollabTransport | null>((done) => (resolve = done));

  const finish = (status: KnockStatus | null, result: CollabTransport | null) => {
    if (settled) return;
    settled = true;
    if (status) onStatus(status);
    relay.close();
    resolve(result);
  };

  const sendKnock = async () => {
    if (knocked) return;
    knocked = true;
    const returning = person.returning ? { peer: person.returning.peer, proof: await returningProof(person.returning.key, link, exchange.publicKey) } : null;
    relay.send('host', await seal(key, 'to-host', { t: 'knock', name, publicKey: exchange.publicKey, ...(returning ? { returning } : {}) }));
  };

  onStatus({ kind: 'connecting' });
  relay.onState((state) => {
    if (state === 'closed' && !settled && !joining) finish({ kind: 'unavailable' }, null);
  });
  relay.onEvent((event) => {
    if (settled) return;
    if (event.kind === 'host') {
      if (event.present) void sendKnock();
      else if (!knocked) onStatus({ kind: 'no-owner' });
      else {
        // The owner left (or dropped) before answering: knock again when they're back.
        knocked = false;
        pair = null;
        onStatus({ kind: 'no-owner' });
      }
      return;
    }
    if (event.kind !== 'message' || event.from !== 'host') return;
    void (async () => {
      const message = readToGuest(await unseal(key, 'to-guest', event.data));
      if (!message || settled) return;
      if (message.t === 'seen') {
        // Only the owner the link names may greet: anyone else holding the link is ignored.
        if (!(await verifyOwner(link, message.ownerKey, greetingStatement(link, exchange.publicKey, message.publicKey, message.owner), message.signature))) return;
        owner = message.owner;
        pair = await exchange.pairWith(message.publicKey, link);
        onStatus({ kind: 'waiting', owner });
      } else if (message.t === 'closed' && pair) {
        const opened = await unseal(pair, 'to-guest', message.box);
        const reason = typeof opened === 'object' && opened !== null ? (opened as { reason?: unknown }).reason : undefined;
        if (reason === 'denied') finish({ kind: 'denied' }, null);
        else if (reason === 'ended') finish({ kind: 'ended' }, null);
      } else if (message.t === 'offer' && pair) {
        const opened = await unseal(pair, 'to-guest', message.box);
        const invite = typeof opened === 'object' && opened !== null ? (opened as { invite?: unknown }).invite : undefined;
        if (typeof invite !== 'string' || joining) return;
        joining = true;
        onStatus({ kind: 'joining', owner });
        try {
          const answer = await joinFromInvite(invite, followOwner(invite, stunServer));
          cancelJoin = answer.cancel;
          if (settled) return answer.cancel();
          relay.send('host', await seal(key, 'to-host', { t: 'answer', box: await seal(pair, 'to-host', { reply: answer.replyCode }) }));
          const connected = await answer.transport;
          // Cancelled while it connected: nobody is waiting for it any more.
          if (settled) connected.close('cancelled');
          else finish(null, connected);
        } catch {
          finish({ kind: 'unavailable' }, null);
        }
      }
    })();
  });

  return {
    transport,
    cancel() {
      if (settled) return;
      void seal(key, 'to-host', { t: 'cancel' }).then((data) => relay.send('host', data)).finally(() => {
        cancelJoin?.();
        finish(null, null);
      });
    },
  };
}
