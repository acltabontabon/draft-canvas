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
import { CLOSE_GRACE_MS, GONE_MS, HEARTBEAT_MS, HOLD_RETRY_MS, REAL_CLOCK, SILENT_MS, type Clock } from './clock';
import { diffFile } from './diff';
import {
  encode,
  exceedsMessageLimit,
  MAX_GUEST_MESSAGE_BYTES,
  parseWire,
  PROTOCOL_VERSION,
  readHostMessage,
  type EndReason,
  type FollowState,
  type GuestMessage,
  type HostMessage,
  type PeerView,
  type Presence,
  type RejectReason,
  type Role,
} from './protocol';
import { Replica } from './replica';
import { sanitizeChanges } from './sanitize';
import type { CollabTransport } from './transport/types';

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
  /** A desktop LAN session's secret. */
  token?: string;
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
}

type Inbound = Extract<HostMessage, { t: 'commit' | 'ack' | 'snapshot' }>;

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
  private holdTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private lastHeard = 0;
  private pingCount = 0;
  /** After a gap in the commits: everything until a fresh snapshot is ignored. */
  private awaitingSnapshot = false;
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

  /** The file as the owner has confirmed it, plus this person's unconfirmed edits. */
  get local(): DraftDocument | null {
    return this.replica?.local ?? null;
  }

  /** Starts talking to the owner over `transport` — the first time, or again after a drop. */
  connect(transport: CollabTransport): void {
    if (this.ended) return transport.close('ended');
    this.release();
    this.transport = transport;
    this.lastHeard = this.clock.now();
    const offMessage = transport.onMessage((text) => {
      this.lastHeard = this.clock.now();
      const message = readHostMessage(parseWire(text));
      if (message) this.receive(message);
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
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      app: this.env.appVersion,
      doc: CURRENT_VERSION,
      name: this.env.name,
      ...(this.env.token === undefined ? {} : { token: this.env.token }),
      ...(this.selfId && this.key && this.replica ? { resume: { peer: this.selfId, key: this.key, seq: this.replica.seq } } : {}),
    });
    this.scheduleHeartbeat();
  }

  /** This person edited the file. */
  localChanged(): void {
    if (!this.replica || this.ended || this.access !== 'editor') return;
    const changes = diffFile(this.replica.local, this.env.readFile());
    if (changes.length === 0) return;
    // Measured before it is recorded: an edit too big to carry would otherwise sit unconfirmed
    // forever, on screen here and nowhere else.
    if (exceedsMessageLimit(encode({ t: 'patch', clientSeq: 1, changes }), MAX_GUEST_MESSAGE_BYTES)) {
      this.env.applyRemote(this.replica.local);
      this.events.tooLarge();
      return;
    }
    const patch = this.replica.propose(changes)!;
    this.send({ t: 'patch', clientSeq: patch.clientSeq, changes: patch.changes });
    this.events.unconfirmed(this.replica.pending.length);
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

  private receive(message: HostMessage): void {
    switch (message.t) {
      case 'welcome':
        return this.welcome(message);
      case 'commit':
      case 'ack':
      case 'snapshot':
        if (!this.replica && message.t !== 'snapshot') return;
        if (this.held.length > 0 || this.env.isBusy()) {
          this.held.push(message);
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
        return this.finish(message.reason);
    }
  }

  private welcome(message: Extract<HostMessage, { t: 'welcome' }>): void {
    if (message.v !== PROTOCOL_VERSION) return this.finish('version');
    const parsed = parseDocument(message.snapshot);
    if (!parsed.ok) return this.finish('protocol');
    // A welcome from a different session (an invite to someone else's, opened while this one was
    // reconnecting) is not this session: unsent edits must not go to it.
    if (this.sessionId !== null && message.session !== this.sessionId) return this.finish('unauthorized');
    this.sessionId = message.session;
    const resuming = this.replica !== null && this.selfId === message.peer;
    this.selfId = message.peer;
    this.key = message.key;
    this.access = message.role;
    this.awaitingSnapshot = false;
    this.held.length = 0;
    if (resuming) {
      this.replica!.reset(parsed.document, message.seq);
      // The owner skips any of these it already applied (it remembers each patch number).
      for (const patch of this.replica!.pending) this.send({ t: 'patch', clientSeq: patch.clientSeq, changes: patch.changes });
      this.env.setAccess(message.role);
      this.env.applyRemote(this.replica!.local);
    } else {
      this.replica = new Replica(parsed.document, message.seq);
      this.env.open(parsed.document, message.role);
    }
    this.events.joined(message.peer, message.role, message.peers.find((peer) => peer.id === message.peer)?.color);
    this.events.peers(message.peers.filter((peer) => peer.id !== message.peer).map((peer) => ({ ...peer, link: 'live' as const })));
    this.events.status('live');
    this.events.unconfirmed(this.replica!.pending.length);
  }

  private apply(message: Inbound): void {
    const replica = this.replica;
    if (message.t === 'snapshot') {
      const parsed = parseDocument(message.snapshot);
      if (!parsed.ok || !replica) return this.finish('protocol');
      replica.reset(parsed.document, message.seq);
      this.awaitingSnapshot = false;
      for (const patch of replica.pending) this.send({ t: 'patch', clientSeq: patch.clientSeq, changes: patch.changes });
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
    while (this.held.length > 0 && !this.env.isBusy()) this.apply(this.held.shift()!);
    if (this.held.length > 0) this.scheduleHold();
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
    this.holdTimer = this.heartbeatTimer = null;
    this.held.length = 0;
    this.events.status('ended', reason);
  }

  private send(message: GuestMessage, priority: 'commit' | 'presence' = 'commit'): void {
    this.transport?.send(encode(message), priority);
  }
}
