/**
 * The owner's end of a session: every collaborator's connection, what each may do, and the order in
 * which their edits reach the owner's file.
 *
 * The owner's file stays in the editor, edited as always; this keeps `HostCore` level with it. Each
 * local commit is diffed and broadcast, each collaborator's patch is checked, applied to the core
 * and then to the editor in the same turn, and broadcast. A patch that arrives while the owner is in
 * the middle of a gesture waits — applying it to the core alone would leave the editor behind, and
 * the next local diff would take the collaborator's edit back out.
 *
 * Nothing here touches the store, the DOM or the network directly: the editor is reached through a
 * `HostEnvironment`, each collaborator through a `CollabTransport`, time through a `Clock`.
 */
import type { DraftDocument } from '../document/types';
import { CURRENT_VERSION } from '../document/types';
import { ByteBudget, CLOSE_GRACE_MS, GONE_MS, HEARTBEAT_MS, HELLO_TIMEOUT_MS, HOLD_RETRY_MS, RateLimit, REAL_CLOCK, SILENT_MS, type Clock } from './clock';
import { Authorship } from './authorship';
import { HostCore, HOST_ORIGIN, type Commit, type PeerLedger } from './hostCore';
import {
  encode,
  exceedsMessageLimit,
  majorOf,
  MAX_GUEST_MESSAGE_BYTES,
  MAX_COLLABORATORS,
  parseWire,
  PROTOCOL_VERSION,
  readGuestMessage,
  type EndReason,
  type FollowState,
  type GuestMessage,
  type HelloMessage,
  type HostMessage,
  type LinkState,
  type PeerInfo,
  type PeerView,
  type Presence,
  type Role,
} from './protocol';
import type { CollabTransport } from './transport/types';

export interface HostEnvironment {
  /** The owner's whole file as the editor holds it now. */
  readFile(): DraftDocument;
  /** Puts a file into the editor without an undo step (`editorStore.applyRemote`). */
  applyRemote(file: DraftDocument): boolean;
  /** Whether a gesture or trace is in progress, so the editor cannot take a change right now. */
  isBusy(): boolean;
  appVersion: string;
  /** A desktop LAN session's check of a hello's secret. Absent when the connection itself is the proof (WebRTC). */
  checkToken?: (token: string | undefined) => boolean;
}

export interface HostEvents {
  peers(peers: PeerView[]): void;
  presence(peerId: string, presence: Presence | null): void;
  /** `peerId` changed the canvas for the first time this session: their changes can now be taken back. */
  authored?(peerId: string): void;
}

/** Ids and secrets: unguessable, from the platform's random source. */
export function randomToken(bytes = 16): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** How many peer colours there are; the owner always has the first. */
export const PEER_COLOR_COUNT = 8;

/** Patches a second, and the burst allowed. A person typing sends at most about twenty. */
const PATCH_RATE = 60;
const PATCH_BURST = 240;
const PRESENCE_RATE = 30;
const PRESENCE_BURST = 60;
/** Unreadable messages tolerated from one connection before it is closed. */
const MAX_BAD_MESSAGES = 20;
/** Bytes a second a collaborator may send, and the burst: a large paste goes through, a stream doesn't. */
const BYTE_RATE = 1024 * 1024;
const BYTE_BURST = 2 * MAX_GUEST_MESSAGE_BYTES;
/** A fresh copy of the file costs the owner a full serialisation; one every few seconds is plenty. */
const RESYNC_RATE = 0.2;
const RESYNC_BURST = 2;
/** What a connection may send before it has introduced itself. A hello is a few hundred bytes. */
const MAX_HELLO_BYTES = 4096;

interface Slot {
  info: PeerInfo;
  key: string;
  ledger: PeerLedger;
  transport: CollabTransport | null;
  link: LinkState;
  lastHeard: number;
  patches: RateLimit;
  presenceLimit: RateLimit;
  resyncs: RateLimit;
  budget: ByteBudget;
  presence: Presence | null;
  release: () => void;
  /** When the connection dropped, for keeping only the most recent dropped places. */
  goneAt?: number;
}

/** Dropped places kept for coming back; older ones are forgotten, so joining and dropping can't grow the list forever. */
const MAX_GONE_PLACES = 10;

interface Pending {
  transport: CollabTransport;
  role: Role;
  /** A re-invite: this connection may only take over this one collaborator's place. */
  reuse?: string;
  /** Let back in without the owner being asked: the place is theirs only with its key. */
  requireKey?: boolean;
  timer: unknown;
  release: () => void;
  bad: number;
}

interface Held {
  slot: Slot;
  clientSeq: number;
  changes: unknown;
}

export class HostSession {
  readonly core: HostCore;
  /**
   * Who changed what. Collaborators' edits never join the owner's undo history (undo takes back only
   * one's own work), so this is how the owner recovers from an editor whose changes went wrong: take
   * back that one person's changes, as an ordinary undoable edit, and nobody else's.
   */
  readonly authorship = new Authorship();
  /**
   * This session's own id. Never sent by a collaborator, only to one: a collaborator reconnecting
   * compares it, so an invite to some other session can't receive their unsent edits.
   */
  readonly id = randomToken(16);
  private readonly slots = new Map<string, Slot>();
  private readonly pending = new Set<Pending>();
  private readonly held: Held[] = [];
  private holdTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private ended = false;
  private ownerPresence: Presence | null = null;
  private follow: FollowState | null = null;
  private pingCount = 0;
  private readonly env: HostEnvironment;
  private readonly events: HostEvents;
  private readonly owner: { name: string };
  private readonly clock: Clock;

  constructor(env: HostEnvironment, events: HostEvents, owner: { name: string }, clock: Clock = REAL_CLOCK) {
    this.env = env;
    this.events = events;
    this.owner = owner;
    this.clock = clock;
    this.core = new HostCore(env.readFile());
    this.scheduleHeartbeat();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** The role a returning collaborator's place had, if that place is waiting for them — for the lobby to let them straight back in. */
  waitingPlace(peerId: string): { role: Role; key: string } | null {
    const slot = this.slots.get(peerId);
    return slot && slot.link !== 'live' ? { role: slot.ledger.role, key: slot.key } : null;
  }

  /** Everyone in the session, the owner first. */
  peers(): PeerView[] {
    return [
      { id: HOST_ORIGIN, name: this.owner.name, color: 0, role: 'owner', link: 'live' },
      ...[...this.slots.values()].map((slot) => ({ ...slot.info, link: slot.link })),
    ];
  }

  /** How many collaborators are connected or still might come back. */
  private occupied(): number {
    let count = this.pending.size;
    for (const slot of this.slots.values()) if (slot.link !== 'gone') count += 1;
    return count;
  }

  /** A new connection, from an accepted invite or the LAN server. It has a few seconds to say hello. */
  attach(transport: CollabTransport, options: { role: Role; reuse?: string; requireKey?: boolean }): void {
    if (this.ended) return transport.close('ended');
    const pending: Pending = {
      transport,
      role: options.role,
      reuse: options.reuse,
      requireKey: options.requireKey,
      bad: 0,
      timer: this.clock.setTimeout(() => this.refuse(pending, 'timeout'), HELLO_TIMEOUT_MS),
      release: () => {},
    };
    const offMessage = transport.onMessage((text) => this.receivePending(pending, text));
    const offState = transport.onState((state) => {
      if (state === 'closed') this.dropPending(pending);
    });
    pending.release = () => {
      offMessage();
      offState();
      this.clock.clearTimeout(pending.timer);
    };
    this.pending.add(pending);
  }

  private dropPending(pending: Pending): void {
    if (!this.pending.delete(pending)) return;
    pending.release();
  }

  private refuse(pending: Pending, reason: EndReason): void {
    pending.transport.send(encode({ t: 'end', reason }), 'commit');
    this.dropPending(pending);
    this.closeSoon(pending.transport, reason);
  }

  /** Closes after the last message has had time to leave — see `CLOSE_GRACE_MS`. */
  private closeSoon(transport: CollabTransport, reason: string): void {
    this.clock.setTimeout(() => transport.close(reason), CLOSE_GRACE_MS);
  }

  private receivePending(pending: Pending, text: string): void {
    if (text.length > MAX_HELLO_BYTES) return this.refuse(pending, 'protocol');
    const message = readGuestMessage(parseWire(text));
    if (!message || message.t !== 'hello') {
      pending.bad += 1;
      if (pending.bad > 3) this.refuse(pending, 'protocol');
      return;
    }
    this.welcome(pending, message);
  }

  private welcome(pending: Pending, hello: HelloMessage): void {
    if (hello.v !== PROTOCOL_VERSION || majorOf(hello.app) !== majorOf(this.env.appVersion) || hello.doc < CURRENT_VERSION) {
      return this.refuse(pending, 'version');
    }
    if (this.env.checkToken && !this.env.checkToken(hello.token)) return this.refuse(pending, 'unauthorized');

    // Coming back: the same place, colour, role and patch numbering. A re-invite names exactly one
    // place, which the owner chose to give back; otherwise reclaiming one takes that place's key.
    const claimed = pending.reuse !== undefined ? this.slots.get(pending.reuse) : hello.resume && this.slots.get(hello.resume.peer);
    const keyMatches = hello.resume !== undefined && claimed !== undefined && hello.resume.peer === claimed.info.id && hello.resume.key === claimed.key;
    const mayClaim = claimed !== undefined && claimed.link !== 'live' && ((pending.reuse !== undefined && !pending.requireKey) || keyMatches);
    let slot: Slot | undefined;
    if (pending.reuse !== undefined && !mayClaim) return this.refuse(pending, 'unauthorized');
    // A place being reclaimed counts once, as the connection now claiming it.
    if (this.occupied() - (mayClaim && claimed.link !== 'gone' ? 1 : 0) > MAX_COLLABORATORS) return this.refuse(pending, 'full');
    if (mayClaim) {
      slot = claimed;
      slot.release();
      // A half-dead connection still open for this place is closed, not left to leak.
      if (slot.transport) slot.transport.close('replaced');
      slot.transport = null;
    }

    this.pending.delete(pending);
    pending.release();
    if (!slot) {
      slot = {
        info: { id: `p_${randomToken(8)}`, name: hello.name, color: this.freeColor(), role: pending.role },
        key: randomToken(16),
        ledger: { role: pending.role, lastClientSeq: 0 },
        transport: null,
        link: 'live',
        lastHeard: this.clock.now(),
        patches: new RateLimit(this.clock, PATCH_RATE, PATCH_BURST),
        presenceLimit: new RateLimit(this.clock, PRESENCE_RATE, PRESENCE_BURST),
        resyncs: new RateLimit(this.clock, RESYNC_RATE, RESYNC_BURST),
        budget: new ByteBudget(this.clock, BYTE_RATE, BYTE_BURST),
        presence: null,
        release: () => {},
      };
      this.slots.set(slot.info.id, slot);
    } else {
      slot.info = { ...slot.info, name: hello.name };
    }
    this.connect(slot, pending.transport);

    // Anything the owner did since the last broadcast goes out first, so the snapshot and the
    // commits after it agree.
    this.commitLocal();
    this.send(slot, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      session: this.id,
      peer: slot.info.id,
      key: slot.key,
      role: slot.ledger.role,
      seq: this.core.seq,
      snapshot: this.core.snapshot(),
      // Only people still in the session: dropped places are kept for coming back, and listing them
      // here could push the list past what a collaborator accepts (`MAX_COLLABORATORS + 1`).
      peers: this.peers()
        .filter((peer) => peer.link !== 'gone')
        .map(({ link: _link, ...info }) => info),
    });
    if (this.ownerPresence) this.send(slot, { t: 'presence', peer: HOST_ORIGIN, presence: this.ownerPresence }, 'presence');
    for (const other of this.slots.values()) {
      if (other !== slot && other.presence) this.send(slot, { t: 'presence', peer: other.info.id, presence: other.presence }, 'presence');
    }
    if (this.follow) this.send(slot, { t: 'follow', state: this.follow });
    this.peersChanged();
  }

  private freeColor(): number {
    const used = new Set([...this.slots.values()].filter((slot) => slot.link !== 'gone').map((slot) => slot.info.color));
    for (let color = 1; color < PEER_COLOR_COUNT; color += 1) if (!used.has(color)) return color;
    return 1 + (this.slots.size % (PEER_COLOR_COUNT - 1));
  }

  private connect(slot: Slot, transport: CollabTransport): void {
    slot.transport = transport;
    slot.link = 'live';
    slot.lastHeard = this.clock.now();
    let bad = 0;
    const offMessage = transport.onMessage((text) => {
      slot.lastHeard = this.clock.now();
      if (slot.link === 'reconnecting') {
        slot.link = 'live';
        this.peersChanged();
      }
      // Size and budget before parsing: parsing is what a hostile peer would make the owner pay for.
      if (exceedsMessageLimit(text, MAX_GUEST_MESSAGE_BYTES)) return this.disconnect(slot, 'too-large');
      if (!slot.budget.spend(text.length)) return this.disconnect(slot, 'protocol');
      const message = readGuestMessage(parseWire(text));
      if (!message) {
        bad += 1;
        if (bad > MAX_BAD_MESSAGES) this.disconnect(slot, 'protocol');
        return;
      }
      this.receive(slot, message);
    });
    const offState = transport.onState((state) => {
      if (state === 'closed' && slot.transport === transport) this.lose(slot);
      else if (state === 'degraded' && slot.link === 'live') {
        slot.link = 'reconnecting';
        this.peersChanged();
      } else if (state === 'open' && slot.link === 'reconnecting') {
        slot.link = 'live';
        this.peersChanged();
      }
    });
    slot.release = () => {
      offMessage();
      offState();
    };
  }

  private receive(slot: Slot, message: GuestMessage): void {
    switch (message.t) {
      case 'patch':
        if (!slot.patches.take()) return this.disconnect(slot, 'protocol');
        if (this.held.length > 0 || this.env.isBusy()) {
          this.held.push({ slot, clientSeq: message.clientSeq, changes: message.changes });
          this.scheduleHold();
          return;
        }
        return this.applyPatch(slot, message.clientSeq, message.changes);
      case 'presence':
        if (!slot.presenceLimit.take()) return;
        slot.presence = message.presence;
        this.events.presence(slot.info.id, message.presence);
        this.broadcast({ t: 'presence', peer: slot.info.id, presence: message.presence }, 'presence', slot);
        return;
      case 'resync':
        if (!slot.resyncs.take()) return;
        this.commitLocal();
        this.send(slot, { t: 'snapshot', seq: this.core.seq, snapshot: this.core.snapshot() });
        return;
      case 'ping':
        this.send(slot, { t: 'pong', n: message.n });
        return;
      case 'pong':
        return;
      case 'bye':
        return this.leave(slot);
      case 'hello':
        return;
    }
  }

  private applyPatch(slot: Slot, clientSeq: number, changes: unknown): void {
    this.commitLocal();
    const before = this.core.file;
    const outcome = this.core.receivePatch(slot.info.id, slot.ledger, clientSeq, changes);
    if (outcome.commit) {
      const first = !this.authorship.has(slot.info.id);
      this.authorship.record(slot.info.id, before, this.core.file);
      if (first) this.events.authored?.(slot.info.id);
      // Same turn as the busy check that let this through, so the editor takes it.
      this.env.applyRemote(this.core.file);
      this.broadcast({ t: 'commit', ...outcome.commit });
    } else if (outcome.ack) {
      this.send(slot, { t: 'ack', ...outcome.ack });
    }
  }

  private scheduleHold(): void {
    if (this.holdTimer !== null || this.ended) return;
    this.holdTimer = this.clock.setTimeout(() => {
      this.holdTimer = null;
      this.drainHeld();
    }, HOLD_RETRY_MS);
  }

  /** Applies what waited for a gesture to end, in the order it arrived. */
  drainHeld(): void {
    while (this.held.length > 0 && !this.env.isBusy()) {
      const next = this.held.shift()!;
      if (this.slots.get(next.slot.info.id) === next.slot) this.applyPatch(next.slot, next.clientSeq, next.changes);
    }
    if (this.held.length > 0) this.scheduleHold();
  }

  /** The owner's own edit (or undo, or anything else that changed the file here). */
  commitLocal(): Commit | null {
    if (this.ended) return null;
    const commit = this.core.commitLocal(this.env.readFile());
    if (commit) this.broadcast({ t: 'commit', ...commit });
    return commit;
  }

  setPresence(presence: Presence | null): void {
    if (this.ended) return;
    this.ownerPresence = presence;
    this.broadcast({ t: 'presence', peer: HOST_ORIGIN, presence }, 'presence');
  }

  setFollow(state: FollowState | null): void {
    if (this.ended) return;
    if (state === null && this.follow === null) return;
    this.follow = state;
    this.broadcast({ t: 'follow', state });
  }

  setRole(peerId: string, role: Role): void {
    const slot = this.slots.get(peerId);
    if (!slot || slot.ledger.role === role) return;
    slot.ledger.role = role;
    slot.info = { ...slot.info, role };
    this.send(slot, { t: 'role', role });
    this.peersChanged();
  }

  /** Takes someone out of the session for good: their place, and any way back into it. */
  remove(peerId: string): void {
    const slot = this.slots.get(peerId);
    if (!slot) return;
    this.send(slot, { t: 'end', reason: 'removed' });
    this.slots.delete(peerId);
    this.forget(slot, 'removed');
  }

  private leave(slot: Slot): void {
    this.slots.delete(slot.info.id);
    this.forget(slot, 'ended');
  }

  private disconnect(slot: Slot, reason: EndReason): void {
    this.send(slot, { t: 'end', reason });
    this.slots.delete(slot.info.id);
    this.forget(slot, reason);
  }

  private forget(slot: Slot, reason: string): void {
    slot.release();
    if (slot.transport) this.closeSoon(slot.transport, reason);
    slot.transport = null;
    slot.link = 'gone';
    for (let i = this.held.length - 1; i >= 0; i -= 1) if (this.held[i]!.slot === slot) this.held.splice(i, 1);
    if (slot.presence) {
      slot.presence = null;
      this.events.presence(slot.info.id, null);
      this.broadcast({ t: 'presence', peer: slot.info.id, presence: null }, 'presence');
    }
    this.peersChanged();
  }

  /** The connection dropped without a goodbye: the place is kept so they can come back — a few of them. */
  private lose(slot: Slot): void {
    slot.release();
    slot.transport = null;
    slot.link = 'gone';
    slot.goneAt = this.clock.now();
    this.pruneGone();
    if (slot.presence) {
      slot.presence = null;
      this.events.presence(slot.info.id, null);
      this.broadcast({ t: 'presence', peer: slot.info.id, presence: null }, 'presence');
    }
    this.peersChanged();
  }

  end(reason: EndReason = 'ended'): void {
    if (this.ended) return;
    this.ended = true;
    this.broadcast({ t: 'end', reason });
    for (const slot of this.slots.values()) {
      slot.release();
      if (slot.transport) this.closeSoon(slot.transport, reason);
    }
    for (const pending of [...this.pending]) {
      this.dropPending(pending);
      this.closeSoon(pending.transport, reason);
    }
    this.slots.clear();
    this.held.length = 0;
    if (this.holdTimer !== null) this.clock.clearTimeout(this.holdTimer);
    if (this.heartbeatTimer !== null) this.clock.clearTimeout(this.heartbeatTimer);
    this.holdTimer = this.heartbeatTimer = null;
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeat();
      if (!this.ended) this.scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  private heartbeat(): void {
    const now = this.clock.now();
    let changed = false;
    this.pingCount += 1;
    for (const slot of this.slots.values()) {
      if (!slot.transport) continue;
      const silent = now - slot.lastHeard;
      if (silent > GONE_MS) {
        slot.transport.close('timeout');
        this.lose(slot);
        continue;
      }
      if (silent > SILENT_MS && slot.link === 'live') {
        slot.link = 'reconnecting';
        changed = true;
      }
      this.send(slot, { t: 'ping', n: this.pingCount });
    }
    if (changed) this.peersChanged();
  }

  private pruneGone(): void {
    const gone = [...this.slots.values()].filter((slot) => slot.link === 'gone').sort((a, b) => (a.goneAt ?? 0) - (b.goneAt ?? 0));
    for (const slot of gone.slice(0, Math.max(0, gone.length - MAX_GONE_PLACES))) this.slots.delete(slot.info.id);
  }

  private peersChanged(): void {
    const peers = this.peers();
    this.events.peers(peers);
    this.broadcast({ t: 'peers', peers: peers.filter((peer) => peer.link !== 'gone').map(({ link: _link, ...info }) => info) });
  }

  private send(slot: Slot, message: HostMessage, priority: 'commit' | 'presence' = 'commit'): void {
    this.deliver(slot, encode(message), priority);
  }

  private broadcast(message: HostMessage, priority: 'commit' | 'presence' = 'commit', except?: Slot): void {
    const text = encode(message);
    for (const slot of [...this.slots.values()]) if (slot !== except && slot.transport) this.deliver(slot, text, priority);
  }

  /**
   * One message to one collaborator. Past `MAX_MESSAGE_BYTES` (a snapshot of a huge diagram, one
   * enormous paste) it cannot be carried, and a collaborator who misses a commit is no longer in step
   * with the file — so they leave with that reason rather than quietly drifting.
   */
  private deliver(slot: Slot, text: string, priority: 'commit' | 'presence'): void {
    if (!slot.transport) return;
    if (exceedsMessageLimit(text)) {
      if (priority === 'commit') this.disconnect(slot, 'too-large');
      return;
    }
    slot.transport.send(text, priority);
  }
}
