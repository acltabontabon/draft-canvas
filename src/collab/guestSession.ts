/**
 * A collaborator's end of a session: the copy of the owner's file this person works on, and the
 * conversation with the owner that keeps it equal.
 *
 * Edits made here are diffed against `Replica.local` — exactly what the editor shows — and sent as
 * patches; the owner's commits advance `Replica.confirmed` in order and the editor is given the new
 * `local`. Commits that arrive during a gesture wait for it, *unapplied*: the replica must keep
 * describing what the editor holds, or the next local diff would take the owner's change back out.
 *
 * Everything from the owner is checked as strictly as the owner checks what collaborators send —
 * an owner's copy can be modified too.
 */
import type { DraftDocument } from '../document/types';
import { CURRENT_VERSION } from '../document/types';
import { parseDocument } from '../document/validate';
import { CLOSE_GRACE_MS, GONE_MS, HEARTBEAT_MS, HOLD_RETRY_MS, REAL_CLOCK, RESYNC_RETRY_MS, SILENT_MS, type Clock } from './clock';
import type { Change } from './changes';
import { diffFile, wireSettings } from './diff';
import {
  encode,
  exceedsMessageLimit,
  MAX_GUEST_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MOVES_PER_PATCH,
  MOVE_BURST,
  MOVE_RATE,
  movesIn,
  parseWire,
  PROTOCOL_VERSION,
  readHostMessage,
  type EndReason,
  type FollowState,
  type GuestMessage,
  type HelloMessage,
  type HostMessage,
  type PeerView,
  type Presence,
  type RejectReason,
  type Resend,
  type Role,
} from './protocol';
import { Replica, type PendingPatch } from './replica';
import { resumeProof, sameSecret } from './rendezvous';
import { sanitizeChanges } from './sanitize';
import type { CollabTransport } from './transport/types';
import { utf8Bytes } from './bytes';

export interface GuestEnvironment {
  readFile(): DraftDocument;
  applyRemote(file: DraftDocument): boolean;
  isBusy(): boolean;
  /** The owner's file, the first time it arrives: opened in the editor with this person's access. */
  open(file: DraftDocument, access: Role): void;
  /** The owner changed what this person may do. */
  setAccess(access: Role): void;
  appVersion: string;
  name: string;
}

export type GuestStatus = 'joining' | 'live' | 'reconnecting' | 'ended';

export interface GuestEvents {
  status(status: GuestStatus, reason?: EndReason): void;
  /** `color` is set on joining, when the owner hands one out; a later role change leaves it as it was. */
  joined(selfId: string, access: Role, color?: number): void;
  peers(peers: PeerView[]): void;
  presence(peerId: string, presence: Presence | null): void;
  presenter(state: FollowState | null): void;
  rejected(reason: RejectReason): void;
  unconfirmed(count: number): void;
  /** An edit made here was too big to share live, and was taken back. */
  tooLarge(): void;
  /** Pending work has filled its budget: the latest edit was taken back, earlier work is kept. */
  backlogFull?(): void;
  /**
   * A link opened to pick this session back up reached some other session (or one that couldn't
   * prove it is this one): that connection is closed and this session carries on reconnecting.
   */
  refusedLink?(): void;
}

type Inbound = Extract<HostMessage, { t: 'commit' | 'ack' | 'snapshot' }>;

function patchBytes(patch: PendingPatch): number {
  return utf8Bytes(encode({ t: 'patch', clientSeq: patch.clientSeq, changes: patch.changes }));
}

/** Unconfirmed work resent at once after a fresh copy, then this many bytes a second: under the owner's budget for a collaborator. */
const RESEND_BURST_BYTES = 6 * 1024 * 1024;
const RESEND_RATE_BYTES = 768 * 1024;

/**
 * What may wait for a gesture here to end. A drag can be held as long as a mouse button can, while a
 * busy session keeps committing; past this the waiting commits are dropped and a fresh copy asked for
 * once the gesture ends, which is the same file for far less memory.
 */
const MAX_HELD = 4096;
const MAX_HELD_BYTES = 2 * MAX_MESSAGE_BYTES;

/**
 * A fresh copy of the owner's file, held to what a change may carry: a file's checks, and no embedded
 * background image — which no change ever carries, and which would otherwise surface only later, in
 * this person's editable copy or an export of it.
 */
function readSnapshot(snapshot: unknown): ReturnType<typeof parseDocument> {
  const parsed = parseDocument(snapshot);
  if (!parsed.ok) return parsed;
  const settings = wireSettings(parsed.document.settings);
  return settings === parsed.document.settings ? parsed : { ...parsed, document: { ...parsed.document, settings } };
}

function resendOf(message: Resend): Resend {
  return message.handled === undefined || message.epoch === undefined ? {} : { handled: message.handled, epoch: message.epoch };
}

export class GuestSession {
  private replica: Replica | null = null;
  private transport: CollabTransport | null = null;
  private release: () => void = () => {};
  private selfId: string | null = null;
  private key: string | null = null;
  /** The session this copy belongs to, from the first welcome. */
  private sessionId: string | null = null;
  private access: Role = 'viewer';
  private readonly held: Inbound[] = [];
  private heldBytes = 0;
  private holdTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private resyncTimer: unknown = null;
  private lastHeard = 0;
  private pingCount = 0;
  /** After a gap in the commits: everything until a fresh snapshot is ignored. */
  private awaitingSnapshot = false;
  /** Commits held for a gesture overflowed and were dropped: a fresh copy is asked for once it ends. */
  private heldOut = false;
  /** A local edit that cannot be shared must wait for its gesture to end before it can be taken back. */
  private restorePending = false;
  /** Patches waiting their turn behind a paced resend (`sendOrDrop`), in the order they must go. */
  private outbox: PendingPatch[] = [];
  private outboxTimer: unknown = null;
  /** Whether this connection's hello has gone: until then nothing else is sent on it (`send`). */
  private greeted = false;
  /** This connection has proved its welcome; an old replica alone does not authenticate it. */
  private welcomed = false;
  /** Whether this connection's welcome must carry the owner's proof (`connect`), and what it must be. */
  private expectProof = false;
  private ownerProof: string | null = null;
  /** The epoch of the last fresh copy taken in, for every patch sent after it (`Resend`); `null` from an older owner. */
  private epoch: number | null = null;
  private ended = false;
  private readonly env: GuestEnvironment;
  private readonly events: GuestEvents;
  private readonly clock: Clock;

  constructor(env: GuestEnvironment, events: GuestEvents, clock: Clock = REAL_CLOCK) {
    this.env = env;
    this.events = events;
    this.clock = clock;
  }

  get id(): string | null {
    return this.selfId;
  }

  /** This collaborator's private resume key, from `welcome` — only for proving a returning knock. */
  get resumeKey(): string | null {
    return this.key;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** What the owner lets this person do now — the latest `role`, not the one the welcome gave. */
  get role(): Role {
    return this.access;
  }

  /** The file as the owner has confirmed it, plus this person's unconfirmed edits. */
  get local(): DraftDocument | null {
    return this.replica?.local ?? null;
  }

  /** Starts talking to the owner over `transport` — the first time, or again after a drop. */
  connect(transport: CollabTransport): void {
    if (this.ended) return transport.close('ended');
    this.release();
    // The connection this one replaces is closed, not just ignored: if it recovered on its own, both
    // would hold a place in the session.
    if (this.transport && this.transport !== transport) this.transport.close('replaced');
    this.transport = transport;
    this.welcomed = false;
    this.lastHeard = this.clock.now();
    const offMessage = transport.onMessage((text) => {
      if (exceedsMessageLimit(text)) return this.finish('too-large');
      this.lastHeard = this.clock.now();
      const message = readHostMessage(parseWire(text));
      if (message) this.receive(message, utf8Bytes(text));
    });
    const offState = transport.onState((state) => {
      if (this.transport !== transport || this.ended) return;
      if (state === 'closed') this.events.status('reconnecting');
      else if (state === 'degraded') this.events.status('reconnecting');
      else if (state === 'open' && this.replica) this.events.status('live');
    });
    this.release = () => {
      offMessage();
      offState();
    };
    this.events.status(this.replica ? 'reconnecting' : 'joining');
    const hello: HelloMessage = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      app: this.env.appVersion,
      doc: CURRENT_VERSION,
      name: this.env.name,
    };
    this.ownerProof = null;
    this.expectProof = false;
    this.greeted = false;
    const peer = this.selfId;
    const key = this.key;
    const session = this.sessionId;
    const binding = transport.binding;
    if (peer && key && this.replica && session && binding !== undefined) {
      // Coming back over a connection that names its far end: proved, not said. The key itself would
      // be handed to whoever made this invite — "Rejoin" on a link from someone else gave them the
      // place — and the owner's answer shows it really is the session this copy belongs to.
      const seq = this.replica.seq;
      this.expectProof = true;
      void Promise.all([resumeProof(key, 'guest', session, binding), resumeProof(key, 'owner', session, binding)]).then(
        ([mine, theirs]) => {
          if (this.transport !== transport || this.ended) return;
          this.ownerProof = theirs;
          this.send({ ...hello, resume: { peer, seq, proof: mine } });
        },
        () => {
          if (this.transport === transport && !this.ended) this.finish('protocol');
        },
      );
    } else {
      this.send({ ...hello, ...(peer && key && this.replica ? { resume: { peer, key, seq: this.replica.seq } } : {}) });
    }
    this.scheduleHeartbeat();
  }

  /** This person edited the file. */
  localChanged(): void {
    if (!this.replica || this.ended || this.access !== 'editor') return;
    const changes = diffFile(this.replica.local, this.env.readFile());
    if (changes.length === 0) {
      this.restorePending = false;
      return;
    }
    // Measured before it is recorded: an edit too big to carry would otherwise sit unconfirmed
    // forever, on screen here and nowhere else.
    // And no more moves than the owner takes in one: refused there, it would be undone all the same.
    if (!this.fits(changes)) {
      this.restorePending = !this.env.applyRemote(this.replica.local);
      if (this.restorePending) this.scheduleHold();
      this.events.tooLarge();
      return;
    }
    this.restorePending = false;
    const patch = this.replica.propose(changes);
    if (!patch) {
      this.restorePending = !this.env.applyRemote(this.replica.local);
      if (this.restorePending) this.scheduleHold();
      if (this.events.backlogFull) this.events.backlogFull();
      else this.events.tooLarge();
      return;
    }
    // Behind anything older still waiting its turn: a newer patch arriving first made the owner take
    // the older ones for repeats.
    if (this.outbox.length > 0) this.outbox.push(patch);
    else this.sendPatch(patch);
    this.events.unconfirmed(this.replica.pending.length);
  }

  /** Whether `changes` fit in one patch: the message, and the moves the owner takes in one. */
  private readonly fits = (changes: unknown): boolean =>
    movesIn(changes) <= MAX_MOVES_PER_PATCH &&
    !exceedsMessageLimit(encode({ t: 'patch', clientSeq: Number.MAX_SAFE_INTEGER, changes, epoch: Number.MAX_SAFE_INTEGER }), MAX_GUEST_MESSAGE_BYTES);

  /**
   * Everything still unconfirmed (`Replica.rebase`'s patches) — or, a piece too large to carry even
   * alone, all of it given up and said so. Paced under the owner's byte budget for a collaborator
   * (`BYTE_BURST` then `BYTE_RATE` in `hostSession.ts`): sent at once, megabytes of offline work got
   * this person disconnected for flooding.
   */
  private sendOrDrop(patches: readonly PendingPatch[]): void {
    const replica = this.replica;
    if (!replica || patches.length === 0) return;
    if (!patches.every((patch) => this.fits(patch.changes))) {
      replica.discardPending();
      this.events.tooLarge();
      return;
    }
    let sent = 0;
    let moved = 0;
    for (const patch of patches) {
      sent += patchBytes(patch);
      moved += movesIn(patch.changes);
      if (this.outbox.length === 0 && sent <= RESEND_BURST_BYTES && moved <= MOVE_BURST) this.sendPatch(patch);
      else this.outbox.push(patch);
    }
    this.scheduleOutbox();
  }

  /** The next patch waiting its turn, once the bytes before it have had time to be taken in. */
  private scheduleOutbox(): void {
    if (this.outboxTimer !== null || this.outbox.length === 0 || this.ended) return;
    this.outboxTimer = this.clock.setTimeout(
      () => {
        this.outboxTimer = null;
        const patch = this.outbox.shift();
        if (patch && this.replica?.pending.includes(patch)) this.sendPatch(patch);
        this.scheduleOutbox();
      },
      // Whichever of the owner's budgets it needs longer to be inside: bytes, or moves.
      Math.max(patchBytes(this.outbox[0]!) / RESEND_RATE_BYTES, movesIn(this.outbox[0]!.changes) / MOVE_RATE) * 1000,
    );
  }

  /** A fresh copy makes everything still waiting go again with it (`Replica.rebase`): none of it is sent as it was. */
  private clearOutbox(): void {
    this.outbox = [];
    if (this.outboxTimer !== null) this.clock.clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
  }

  private sendPatch(patch: { clientSeq: number; changes: unknown }): void {
    this.send({ t: 'patch', clientSeq: patch.clientSeq, changes: patch.changes, ...(this.epoch === null ? {} : { epoch: this.epoch }) });
  }

  setPresence(presence: Presence): void {
    if (!this.replica || this.ended) return;
    this.send({ t: 'presence', presence }, 'presence');
  }

  /** Leaves on purpose: the owner hears a goodbye rather than waiting for a timeout. */
  leave(): void {
    if (this.ended) return;
    this.send({ t: 'bye' });
    this.finish('ended');
  }

  private receive(message: HostMessage, bytes: number): void {
    // A reconnecting copy still has its replica and private offline edits. Until this connection
    // answers the resume proof, neither its messages nor our edits may cross that trust boundary.
    if (!this.welcomed && message.t !== 'welcome' && message.t !== 'ping' && message.t !== 'pong' && message.t !== 'end') return;
    switch (message.t) {
      case 'welcome':
        return this.welcome(message, bytes);
      case 'commit':
      case 'ack':
      case 'snapshot':
        if (!this.replica && message.t !== 'snapshot') return;
        if (this.held.length > 0 || this.heldOut || this.env.isBusy()) {
          if (this.heldOut) return this.scheduleHold();
          if (this.held.length >= MAX_HELD || this.heldBytes + bytes > MAX_HELD_BYTES) {
            this.held.length = 0;
            this.heldBytes = 0;
            this.heldOut = true;
          } else {
            this.held.push(message);
            this.heldBytes += bytes;
          }
          this.scheduleHold();
          return;
        }
        return this.apply(message);
      case 'peers':
        this.events.peers(message.peers.filter((peer) => peer.id !== this.selfId).map((peer) => ({ ...peer, link: 'live' as const })));
        return;
      case 'role':
        this.access = message.role;
        this.env.setAccess(message.role);
        if (message.role === 'viewer') {
          // The last drop may still be waiting for the bridge to send it. It can no longer be
          // shared, and without another commit it would otherwise stay here as if it had been.
          this.restorePending = this.env.isBusy() || !this.env.applyRemote(this.replica!.local);
          if (this.restorePending) this.scheduleHold();
        }
        this.events.joined(this.selfId!, message.role);
        return;
      case 'presence':
        if (message.peer !== this.selfId) this.events.presence(message.peer, message.presence);
        return;
      case 'follow':
        this.events.presenter(message.state);
        return;
      case 'ping':
        this.send({ t: 'pong', n: message.n });
        return;
      case 'pong':
        return;
      case 'end':
        if (!this.welcomed && this.expectProof) return this.refuseLink();
        return this.finish(message.reason);
    }
  }

  private welcome(message: Extract<HostMessage, { t: 'welcome' }>, bytes: number): void {
    if (this.welcomed) return;
    // A welcome from a different session (an invite to someone else's, opened while this one was
    // reconnecting) is not this session: unsent edits must not go to it.
    if (this.sessionId !== null && message.session !== this.sessionId) return this.refuseLink();
    // Anyone who was in the session knows its id: only the owner can answer a proof with one of its own.
    if (this.expectProof && !(message.proof !== undefined && this.ownerProof !== null && sameSecret(message.proof, this.ownerProof))) return this.refuseLink();
    if (message.v !== PROTOCOL_VERSION) return this.finish('version');
    const parsed = readSnapshot(message.snapshot);
    if (!parsed.ok) return this.finish('protocol');
    this.welcomed = true;
    this.sessionId = message.session;
    const resuming = this.replica !== null && this.selfId === message.peer;
    // Back, but as someone new: the owner forgot this place (more people dropped meanwhile than it
    // keeps). What is on screen and not yet confirmed comes along rather than vanishing unsaid.
    // Kept as the separate edits they were, so a resend can still split them into patches that fit.
    const unconfirmed: Change[][] = [];
    if (this.replica && !resuming) {
      for (const patch of this.replica.pending) unconfirmed.push(patch.changes);
      const unsent = diffFile(this.replica.local, this.env.readFile());
      if (unsent.length > 0) unconfirmed.push(unsent);
    }
    this.selfId = message.peer;
    this.key = message.key;
    this.access = message.role;
    this.awaitingSnapshot = false;
    this.held.length = 0;
    this.heldBytes = 0;
    this.heldOut = false;
    if (resuming) {
      this.env.setAccess(message.role);
      // Taken in like any snapshot: after a gesture under way has ended, and after the edits on screen
      // since the drop are in the replica. Reset while a drag still held the old file, the editor kept
      // it, and the next local diff sent the owner's offline work back out as this person's deletions.
      this.held.push({ t: 'snapshot', seq: message.seq, snapshot: message.snapshot, ...resendOf(message) });
      this.heldBytes = bytes;
      this.drainHeld();
    } else {
      this.restorePending = false;
      this.replica = new Replica(parsed.document, message.seq);
      // A fresh page given an old place back numbers its patches on from where that place left off.
      if (message.handled !== undefined) this.replica.rebase(message.handled);
      this.epoch = message.epoch ?? null;
      this.clearOutbox();
      if (unconfirmed.length > 0) {
        if (message.role === 'editor') {
          for (const changes of unconfirmed) {
            if (!this.replica.propose(changes)) this.events.tooLarge();
          }
          this.sendOrDrop(this.replica.rebase(message.handled ?? 0, this.fits));
        } else this.events.rejected('view-only');
      }
      this.env.open(this.replica.local, message.role);
    }
    this.events.joined(message.peer, message.role, message.peers.find((peer) => peer.id === message.peer)?.color);
    this.events.peers(message.peers.filter((peer) => peer.id !== message.peer).map((peer) => ({ ...peer, link: 'live' as const })));
    this.events.status('live');
    this.events.unconfirmed(this.replica!.pending.length);
  }

  /**
   * A connection meant to pick this session up that reached another (someone else's invite, opened
   * while reconnecting). Nothing more goes over it; ending the session there ended the real one too.
   */
  private refuseLink(): void {
    const transport = this.transport;
    this.release();
    this.release = () => {};
    this.transport = null;
    this.expectProof = false;
    transport?.close('unauthorized');
    this.events.status('reconnecting');
    this.events.refusedLink?.();
  }

  private apply(message: Inbound): void {
    // An edit the editor holds and hasn't sent yet — a drag's drop, waiting out the bridge's gesture
    // timer — goes into the replica first. Applied over, `local` would replace it on screen and the
    // later diff would find nothing to send: the shape snapped back and the move was never shared.
    this.localChanged();
    const replica = this.replica;
    if (message.t === 'snapshot') {
      const parsed = readSnapshot(message.snapshot);
      if (!parsed.ok || !replica) return this.finish('protocol');
      replica.reset(parsed.document, message.seq);
      this.awaitingSnapshot = false;
      if (message.handled !== undefined && message.epoch !== undefined) {
        this.clearOutbox();
        // Everything still unconfirmed goes as one patch, in the new epoch: the owner has dropped any
        // sent before the copy, so none can land out of order — and one patch can't trip a rate limit.
        this.epoch = message.epoch;
        this.sendOrDrop(replica.rebase(message.handled, this.fits));
      } else {
        // An older owner skips any of these it already applied (it remembers each patch number).
        for (const patch of replica.pending) this.sendPatch(patch);
      }
    } else if (message.t === 'ack') {
      replica!.acknowledge(message.clientSeq);
      if (message.rejected) this.events.rejected(message.rejected);
    } else {
      if (this.awaitingSnapshot) return;
      const changes = sanitizeChanges(message.changes);
      if (!changes.ok) return this.resync();
      const own = message.origin === this.selfId ? message.clientSeq : undefined;
      const outcome = replica!.receiveCommit(message.seq, changes.changes, own);
      // The owner always commits a repaired file. One that isn't — a dangling reference, a boundary
      // cycle the editor could loop on — came from a broken or modified copy: start again from a snapshot.
      if (outcome === 'invalid') return this.resync();
      if (outcome === 'gap') return this.resync();
      if (outcome === 'duplicate') return;
    }
    this.env.applyRemote(this.replica!.local);
    this.events.unconfirmed(this.replica!.pending.length);
  }

  private resync(): void {
    this.awaitingSnapshot = true;
    this.send({ t: 'resync' });
    // The owner answers a few requests at a time and drops the rest without a word (or the snapshot
    // is lost on the way): asked once, this copy would ignore every commit for good while still
    // showing "live". Ask again until a snapshot comes.
    if (this.resyncTimer !== null) this.clock.clearTimeout(this.resyncTimer);
    this.resyncTimer = this.clock.setTimeout(() => {
      this.resyncTimer = null;
      if (this.awaitingSnapshot && !this.ended) this.resync();
    }, RESYNC_RETRY_MS);
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
    // A rejected edit is not in the replica. Take it back before applying anything over it, even
    // when the owner sends nothing else: the bridge's last send may have run mid-gesture.
    if (this.restorePending && !this.env.isBusy()) this.restorePending = !this.env.applyRemote(this.replica!.local);
    if (this.restorePending) return this.scheduleHold();
    const started = this.clock.now();
    let processed = 0;
    while (this.held.length > 0 && !this.env.isBusy() && processed < 32 && this.clock.now() - started < 8) {
      processed += 1;
      this.apply(this.held.shift()!);
    }
    if (this.held.length === 0) this.heldBytes = 0;
    if (this.heldOut && !this.env.isBusy()) {
      this.heldOut = false;
      // Anything the gesture made goes into the replica first, as `apply` does, then a fresh copy.
      this.localChanged();
      this.resync();
    }
    if (this.held.length > 0 || this.heldOut) this.scheduleHold();
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.clock.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.ended) return;
      const silent = this.clock.now() - this.lastHeard;
      if (silent > GONE_MS) {
        this.transport?.close('timeout');
        this.events.status('reconnecting');
      } else if (silent > SILENT_MS) {
        this.events.status('reconnecting');
      }
      this.pingCount += 1;
      this.send({ t: 'ping', n: this.pingCount });
      this.scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  private finish(reason: EndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.release();
    const transport = this.transport;
    // A goodbye just sent needs a moment to leave before the channel closes.
    if (transport) this.clock.setTimeout(() => transport.close(reason), CLOSE_GRACE_MS);
    this.transport = null;
    if (this.holdTimer !== null) this.clock.clearTimeout(this.holdTimer);
    if (this.heartbeatTimer !== null) this.clock.clearTimeout(this.heartbeatTimer);
    if (this.resyncTimer !== null) this.clock.clearTimeout(this.resyncTimer);
    this.holdTimer = this.heartbeatTimer = this.resyncTimer = null;
    this.held.length = 0;
    this.heldBytes = 0;
    this.heldOut = false;
    this.restorePending = false;
    this.clearOutbox();
    this.events.status('ended', reason);
  }

  private send(message: GuestMessage, priority: 'commit' | 'presence' = 'commit'): void {
    // Nothing goes ahead of the hello on a new connection: the owner reads the first message as it,
    // and a patch there (one made while a resume proof was being worked out) closed the connection.
    if (!this.greeted && message.t !== 'hello') return;
    if (!this.welcomed && (message.t === 'patch' || message.t === 'presence' || message.t === 'resync')) return;
    if (message.t === 'hello') this.greeted = true;
    this.transport?.send(encode(message), priority);
  }
}
