import { encodeFrames, Reassembler, MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, type DropReason, type FrameKind } from './chunk';
import { CollabCodeError, compactSdp, decodeInvite, decodeReply, encodeInvite, encodeReply, expandSdp, fingerprintText, newNonce, withSafeCandidates } from './invite';
import type { CollabTransport, IceConfig, SendPriority, TransportState } from './types';

/**
 * Peer-to-peer collaboration over a WebRTC DataChannel, signaled by hand.
 *
 * The owner's tab calls `createHostOffer` once per collaborator: one RTCPeerConnection, one ordered,
 * reliable, pre-negotiated DataChannel, and an invite carrying the complete offer. ICE does not
 * trickle — there is no signaling channel to trickle over — so both sides wait for gathering to
 * finish (at most 5 s) before encoding. The collaborator's `joinFromInvite` answers it and yields
 * the reply code the owner pastes into `acceptReply`.
 *
 * Once open, the channel carries chunked frames (`chunk.ts`). Presence is best-effort: it is dropped
 * whenever the channel's buffer is above a low watermark, or commits are waiting. Commits are never
 * dropped; they queue until the buffer drains, and a queue that stays stuck for 5 s marks the
 * transport 'degraded'. A connection that goes `disconnected` is 'degraded' too, while the owner
 * attempts an ICE restart, exchanging the new offer and answer over the still-open DataChannel as
 * control frames. If it has not recovered within 20 s, the transport closes.
 *
 * That restart travels the path that just failed, so it only helps when packets cross again by
 * themselves (a Wi‑Fi blip); after a real network change (Wi‑Fi to cellular) its offer never arrives.
 * Recovery from that does not wait for it: a 'degraded' transport makes the session 'reconnecting'
 * at once, and a guest who joined by session link knocks again through the relay as returning
 * (`ui/collab/relayGuest.ts`), which gives their place back even while the old link still looks up
 * on the owner's side. A guest who came by direct invite has no other way back, which is why the 20 s
 * is not shorter: it is their chance for the path to return. Signalling the restart through the relay
 * instead would keep every guest's relay socket open for the whole session, for what a fresh
 * knock already does.
 *
 * Close reasons, as `onState` reports them: 'connect-timeout', 'reconnect-timeout', 'failed',
 * 'peer-closed', 'queue-overflow', 'cancelled', or whatever the caller passed to `close`.
 * Degraded reasons: 'disconnected' and 'congested'.
 *
 * A caller's `close` is graceful: the transport reads 'closed' at once, but what was already sent —
 * a goodbye, the reason a session ended — keeps draining for up to `CLOSE_DRAIN_MS` before the
 * connection is torn down. Closing the peer connection at once would discard it, and the other side
 * would see a lost connection instead of the reason.
 */

export const ICE_GATHER_TIMEOUT_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 30_000;
export const ICE_RESTART_GIVE_UP_MS = 20_000;
export const CONGESTION_DEGRADE_MS = 5_000;
/** Above this many buffered bytes, presence is dropped and the channel wakes us when it falls back. */
export const BUFFER_LOW_WATERMARK = 256 * 1024;
/** Commits stop being handed to the channel above this, so its own send queue never fills. */
export const BUFFER_HIGH_WATERMARK = 1024 * 1024;
/** Unsent commits past this mean the peer is not reading at all; holding more would only grow. */
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
/** How long a closed transport keeps sending what it had queued before it lets the connection go. */
export const CLOSE_DRAIN_MS = 2_000;
/** Restarts are rare. Control frames bypass the session's application-message rate limits. */
const CONTROL_WINDOW_MS = 10_000;
const MAX_CONTROLS_PER_WINDOW = 8;
const MAX_CONTROL_CHARS = 70 * 1024;

type PeerConnectionCtor = new (configuration: RTCConfiguration) => RTCPeerConnection;

export interface WebRtcOptions {
  /** The RTCPeerConnection to use. Defaults to the browser's; tests pass a fake. */
  peerConnection?: PeerConnectionCtor;
  /** The clock invites are stamped and checked against. */
  now?: () => number;
  /** Frames the peer sent that could not be read, dropped rather than delivered. */
  onDrop?: (reason: DropReason, detail: string) => void;
  /** The largest message the peer may send: the owner's side takes far less from a collaborator than the transport's cap. */
  maxMessageBytes?: number;
}

export interface HostOffer {
  /** `1.<payload>`, for the invite link's fragment (`inviteFragment`). */
  readonly invitePayload: string;
  readonly expiresAt: number;
  /**
   * Applies the collaborator's reply code and resolves once the channel opens. A code that does not
   * decode, or answers another invite, rejects with a `CollabCodeError` and may be retried with a
   * corrected code; once a code has been applied, the invite is spent.
   */
  acceptReply(code: string): Promise<CollabTransport>;
  cancel(): void;
}

export interface JoinResult {
  /** What the collaborator sends back to the owner. */
  readonly replyCode: string;
  /** Resolves once the owner has applied the reply and the channel opens. */
  readonly transport: Promise<CollabTransport>;
  cancel(): void;
}

/** Whether this browser can make peer connections at all (some webviews and locked-down browsers can't). */
export function peerConnectionsAvailable(): boolean {
  return typeof globalThis.RTCPeerConnection === 'function';
}

export async function createHostOffer(config: IceConfig, opts: WebRtcOptions = {}): Promise<HostOffer> {
  const now = opts.now ?? Date.now;
  const pc = new (peerConnectionCtor(opts))(rtcConfiguration(config));
  const transport = new WebRtcTransport(pc, 'host', opts);
  let invitePayload: string;
  let expiresAt: number;
  const nonce = newNonce();
  try {
    const gathering = watchGathering(pc, transport.signal);
    await pc.setLocalDescription(await pc.createOffer());
    await gathering.wait(ICE_GATHER_TIMEOUT_MS);
    if (transport.state === 'closed') throw new Error('The invite was cancelled.');
    const offer = compactSdp(localSdp(pc));
    transport.binding = fingerprintText(offer.fingerprint);
    ({ payload: invitePayload, expiresAt } = encodeInvite({ nonce, issuedAt: now(), offer }));
  } catch (error) {
    transport.close('cancelled');
    throw error;
  }
  let spent = false;
  return {
    invitePayload,
    expiresAt,
    async acceptReply(code) {
      if (transport.state === 'closed') throw new Error('This invite was cancelled.');
      if (spent) throw new Error('This invite has already been answered.');
      const answer = decodeReply(code, { nonce, expiresAt }, now());
      spent = true;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: expandSdp(answer) });
      } catch {
        transport.close('failed');
        throw new CollabCodeError('malformed', 'This reply code could not be used. Ask for a new one.');
      }
      return transport.opened(CONNECT_TIMEOUT_MS);
    },
    cancel() {
      transport.close('cancelled');
    },
  };
}

export async function joinFromInvite(payload: string, config: IceConfig, opts: WebRtcOptions = {}): Promise<JoinResult> {
  const now = opts.now ?? Date.now;
  const invite = decodeInvite(payload, now());
  const pc = new (peerConnectionCtor(opts))(rtcConfiguration(config));
  const transport = new WebRtcTransport(pc, 'guest', opts);
  // The owner's certificate, as the browser will hold the connection to it.
  transport.binding = fingerprintText(invite.offer.fingerprint);
  try {
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: expandSdp(invite.offer) });
    } catch {
      throw new CollabCodeError('malformed', 'This invite could not be used. Ask for a new one.');
    }
    const gathering = watchGathering(pc, transport.signal);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathering.wait(ICE_GATHER_TIMEOUT_MS);
    if (transport.state === 'closed') throw new Error('Joining was cancelled.');
    const replyCode = encodeReply({ nonce: invite.nonce, answer: compactSdp(localSdp(pc)) });
    // The owner may paste the reply right up to the invite's expiry; give the connection time after that.
    const ready = transport.opened(Math.max(CONNECT_TIMEOUT_MS, invite.expiresAt - now() + CONNECT_TIMEOUT_MS));
    // A caller that only ever cancels should not see an unhandled rejection for it.
    ready.catch(() => {});
    return { replyCode, transport: ready, cancel: () => transport.close('cancelled') };
  } catch (error) {
    transport.close('cancelled');
    throw error;
  }
}

function peerConnectionCtor(opts: WebRtcOptions): PeerConnectionCtor {
  const ctor = opts.peerConnection ?? (globalThis as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection;
  if (!ctor) throw new Error('This browser cannot make peer-to-peer connections.');
  return ctor;
}

export function rtcConfiguration(config: IceConfig): RTCConfiguration {
  return {
    iceServers: config.localOnly ? [] : config.servers.map((server) => ({ ...server })),
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };
}

function localSdp(pc: RTCPeerConnection): string {
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error('The browser produced no session description.');
  return sdp;
}

/**
 * Watches for ICE gathering to finish. Created *before* `setLocalDescription`, so a fast gather — or
 * an ICE restart's, which starts from a state that already reads 'complete' — cannot finish unseen.
 */
function watchGathering(pc: RTCPeerConnection, signal: AbortSignal): { wait(timeoutMs: number): Promise<void> } {
  const listening = new AbortController();
  let complete = false;
  let wake: (() => void) | null = null;
  const finish = () => {
    complete = true;
    listening.abort();
    wake?.();
  };
  const options = { signal: listening.signal };
  // Closing the connection stops the watch, and any wait on it, at once.
  signal.addEventListener('abort', finish, options);
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') finish();
  }, options);
  pc.addEventListener('icecandidate', (event) => {
    if (!event.candidate) finish();
  }, options);
  return {
    wait(timeoutMs) {
      return new Promise((resolve) => {
        if (complete) return resolve();
        // Past the cap, use what was gathered: a candidate that is still on its way can only be a
        // slow STUN or TURN server, and the remote side learns peer-reflexive ones from our checks.
        const timer = setTimeout(() => {
          listening.abort();
          resolve();
        }, timeoutMs);
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        wake = stop;
      });
    },
  };
}

type Role = 'host' | 'guest';
type Control = { t: 'restart-offer' | 'restart-answer'; gen: number; sdp: string };

class WebRtcTransport implements CollabTransport {
  readonly kind = 'webrtc';
  private current: TransportState = 'connecting';
  private readonly pc: RTCPeerConnection;
  private readonly channel: RTCDataChannel;
  private readonly role: Role;
  private readonly onDrop?: (reason: DropReason, detail: string) => void;
  private readonly lifetime = new AbortController();
  private readonly reassembler: Reassembler;
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly stateListeners = new Set<(state: TransportState, reason?: string) => void>();
  /** Frames waiting for buffer room, oldest first, from `head`. */
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private head = 0;
  private queuedBytes = 0;
  private nextId = 0;
  private maxFrame = MAX_CHUNK_BYTES;
  private everOpen = false;
  private iceLost = false;
  private congested = false;
  private congestionTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by a graceful close while the queue drains: the reason, and the cap on how long it may take. */
  private closing: { reason: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private released = false;
  private restartGeneration = 0;
  private controlWindow = Date.now();
  private controls = 0;
  private handlingControl = false;
  private answeredGeneration = 0;
  private waiters: { resolve(transport: CollabTransport): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(pc: RTCPeerConnection, role: Role, opts: Pick<WebRtcOptions, 'onDrop' | 'maxMessageBytes'> = {}) {
    this.pc = pc;
    this.role = role;
    this.onDrop = opts.onDrop;
    // Pre-negotiated on both sides: no in-band channel announcement to wait for or lose.
    this.channel = pc.createDataChannel('draft-canvas', { negotiated: true, id: 0, ordered: true });
    this.channel.binaryType = 'arraybuffer';
    this.channel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;
    this.reassembler = new Reassembler({
      onMessage: (text, kind) => this.receive(text, kind),
      onDrop: (reason, detail) => this.lostFrame(reason, detail),
      ...(opts.maxMessageBytes === undefined ? {} : { maxMessageBytes: opts.maxMessageBytes }),
    });
    const options = { signal: this.lifetime.signal };
    this.channel.addEventListener('open', () => this.onOpen(), options);
    this.channel.addEventListener('close', () => this.teardown('peer-closed'), options);
    this.channel.addEventListener('message', (event) => this.reassembler.push(event.data), options);
    this.channel.addEventListener('bufferedamountlow', () => this.pump(), options);
    pc.addEventListener('connectionstatechange', () => this.onConnectionState(), options);
  }

  /** See `CollabTransport.binding`: the owner's certificate fingerprint, set once it is known. */
  binding: string | undefined = undefined;

  get state(): TransportState {
    return this.current;
  }

  /** Aborted on close: anything waiting on this connection stops with it. */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  send(message: string, priority: SendPriority): boolean {
    if (this.current === 'closed') return false;
    if (priority === 'presence') {
      if (!this.canSendPresence()) return false;
      try {
        for (const frame of this.frames(message, 'message')) this.channel.send(frame);
      } catch (error) {
        if (error instanceof RangeError) throw error;
        return false;
      }
      return true;
    }
    for (const frame of this.frames(message, 'message')) this.enqueue(frame);
    this.pump();
    // Only an overflowing queue closes here, and then the commit is lost with the connection.
    return this.state !== 'closed';
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: TransportState, reason?: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  close(reason = 'closed'): void {
    if (this.current === 'closed') return;
    if (this.channel.readyState !== 'open' || (this.queuedBytes === 0 && this.channel.bufferedAmount === 0)) return this.teardown(reason);
    // Closed to whoever used it from now on, while its last messages leave.
    this.closing = { reason, timer: setTimeout(() => this.teardown(reason), CLOSE_DRAIN_MS) };
    this.setState('closed', reason);
    this.messageListeners.clear();
    this.stateListeners.clear();
    // Woken when the browser's buffer is empty, not just low: then everything has been handed on.
    this.channel.bufferedAmountLowThreshold = 0;
    this.pump();
  }

  /** Lets the connection go at once, with whatever was still queued. */
  private teardown(reason: string): void {
    if (this.released) return;
    this.released = true;
    this.lifetime.abort();
    this.clearCongestionTimer();
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.closing) clearTimeout(this.closing.timer);
    this.closing = null;
    this.reassembler.dispose();
    this.queue = [];
    this.head = 0;
    this.queuedBytes = 0;
    try {
      this.channel.close();
    } catch { /* Already closing: nothing more to release. */ }
    try {
      this.pc.close();
    } catch { /* Already closed. */ }
    this.setState('closed', reason);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`The connection closed before it opened (${reason}).`));
    }
    this.messageListeners.clear();
    this.stateListeners.clear();
  }

  /** Resolves with this transport once the channel opens; closes it after `timeoutMs` otherwise. */
  opened(timeoutMs: number): Promise<CollabTransport> {
    if (this.current === 'closed') return Promise.reject(new Error('The connection is closed.'));
    if (this.everOpen) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.teardown('connect-timeout'), timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private onOpen(): void {
    this.everOpen = true;
    // The peer's limit, when the browser knows it; never above our own frame size.
    const limit = this.pc.sctp?.maxMessageSize;
    this.maxFrame = limit ? Math.max(MIN_CHUNK_BYTES, Math.min(MAX_CHUNK_BYTES, limit)) : MAX_CHUNK_BYTES;
    this.refresh();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(this);
    }
    this.pump();
  }

  private frames(message: string, kind: FrameKind): Uint8Array<ArrayBuffer>[] {
    const id = this.nextId;
    this.nextId = (this.nextId + 1) >>> 0;
    return encodeFrames(message, id, kind, this.maxFrame);
  }

  private canSendPresence(): boolean {
    return this.current === 'open' && this.channel.readyState === 'open' && this.queuedBytes === 0 && this.channel.bufferedAmount <= BUFFER_LOW_WATERMARK;
  }

  private enqueue(frame: Uint8Array<ArrayBuffer>, first = false): void {
    // Overflow tears down in the middle of enqueueing a multi-frame message. Its remaining frames
    // must not repopulate the released transport's queue after teardown cleared it.
    if (this.released) return;
    if (first) {
      if (this.head > 0) this.queue[--this.head] = frame;
      else this.queue.unshift(frame);
    } else {
      this.queue.push(frame);
    }
    this.queuedBytes += frame.length;
    if (this.queuedBytes > MAX_QUEUED_BYTES) this.teardown('queue-overflow');
  }

  private pump(): void {
    if (this.released) return;
    while (this.head < this.queue.length && this.channel.readyState === 'open' && this.channel.bufferedAmount <= BUFFER_HIGH_WATERMARK) {
      const frame = this.queue[this.head]!;
      try {
        this.channel.send(frame);
      } catch {
        // The browser's own queue is full or the channel is closing: keep the frame and wait for
        // 'bufferedamountlow' or the close event, whichever comes.
        break;
      }
      this.head++;
      this.queuedBytes -= frame.length;
    }
    if (this.head >= this.queue.length) {
      this.queue = [];
      this.head = 0;
      this.clearCongestionTimer();
      if (this.closing) {
        if (this.channel.bufferedAmount === 0) this.teardown(this.closing.reason);
        return;
      }
      if (this.congested) {
        this.congested = false;
        this.refresh();
      }
      return;
    }
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    if (this.congestionTimer === null && !this.congested && !this.closing) {
      this.congestionTimer = setTimeout(() => {
        this.congestionTimer = null;
        this.congested = true;
        this.refresh();
      }, CONGESTION_DEGRADE_MS);
    }
  }

  private clearCongestionTimer(): void {
    if (this.congestionTimer !== null) clearTimeout(this.congestionTimer);
    this.congestionTimer = null;
  }

  private onConnectionState(): void {
    // Draining a graceful close: a connection that is going away takes the rest with it.
    if (this.closing) {
      const state = this.pc.connectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') this.teardown(this.closing.reason);
      else this.pump();
      return;
    }
    switch (this.pc.connectionState) {
      case 'connected':
        this.iceLost = false;
        if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
        this.refresh();
        this.pump();
        return;
      case 'disconnected':
        if (!this.everOpen) return;
        this.iceLost = true;
        this.refresh();
        this.beginRecovery();
        return;
      case 'failed':
        // Before the first open, a collaborator's checks can fail while the owner is still pasting
        // the reply; the owner's own checks revive them once it is applied. The connect timeout
        // decides that case. After the first open, failure is final.
        if (!this.everOpen && this.role === 'guest') return;
        this.teardown('failed');
        return;
      case 'closed':
        this.teardown('peer-closed');
        return;
      default:
        return;
    }
  }

  private beginRecovery(): void {
    if (this.recoveryTimer !== null) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.teardown('reconnect-timeout');
    }, ICE_RESTART_GIVE_UP_MS);
    // Only the owner offers, so the two sides never restart into each other.
    if (this.role === 'host') void this.restartIce();
  }

  private async restartIce(): Promise<void> {
    const gen = ++this.restartGeneration;
    try {
      const gathering = watchGathering(this.pc, this.lifetime.signal);
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      await gathering.wait(ICE_GATHER_TIMEOUT_MS);
      if (this.current === 'closed' || gen !== this.restartGeneration) return;
      this.sendControl({ t: 'restart-offer', gen, sdp: localSdp(this.pc) });
    } catch {
      // The browser refused to restart. Recovery may still happen on its own; the give-up timer
      // closes the transport if it does not.
    }
  }

  private async answerRestart(control: Control): Promise<void> {
    try {
      // Held to an invite's rules: the peer writes this, and the browser would look up any name in it.
      await this.pc.setRemoteDescription({ type: 'offer', sdp: withSafeCandidates(control.sdp) });
      const gathering = watchGathering(this.pc, this.lifetime.signal);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await gathering.wait(ICE_GATHER_TIMEOUT_MS);
      if (this.current === 'closed') return;
      this.sendControl({ t: 'restart-answer', gen: control.gen, sdp: localSdp(this.pc) });
    } catch {
      this.reportDrop('malformed', 'ICE restart offer was refused');
    }
  }

  private async applyRestartAnswer(control: Control): Promise<void> {
    // A late answer to an earlier attempt would be applied against the wrong offer.
    if (control.gen !== this.restartGeneration || this.pc.signalingState !== 'have-local-offer') return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: withSafeCandidates(control.sdp) });
    } catch {
      this.reportDrop('malformed', 'ICE restart answer was refused');
    }
  }

  private sendControl(control: Control): void {
    // Ahead of queued commits: the restart is what lets them through again.
    const frames = this.frames(JSON.stringify(control), 'control');
    for (let i = frames.length - 1; i >= 0; i--) this.enqueue(frames[i]!, true);
    this.pump();
  }

  private receive(text: string, kind: FrameKind): void {
    if (this.current === 'closed') return;
    if (kind === 'control') {
      // Before JSON parsing or calling the browser: a hostile guest can send these without ever
      // reaching HostSession's byte and message budgets.
      const now = Date.now();
      if (now - this.controlWindow >= CONTROL_WINDOW_MS) {
        this.controlWindow = now;
        this.controls = 0;
      }
      if (text.length > MAX_CONTROL_CHARS || ++this.controls > MAX_CONTROLS_PER_WINDOW) {
        return this.lostFrame('overflow', 'too much ICE restart control traffic');
      }
      const control = parseControl(text);
      if (!control) return this.reportDrop('malformed', 'unreadable control frame');
      if (this.handlingControl) return;
      if (control.t === 'restart-offer' && this.role === 'guest') {
        if (control.gen <= this.answeredGeneration) return;
        this.answeredGeneration = control.gen;
        this.handlingControl = true;
        void this.answerRestart(control).finally(() => { this.handlingControl = false; });
      } else if (control.t === 'restart-answer' && this.role === 'host') {
        this.handlingControl = true;
        void this.applyRestartAnswer(control).finally(() => { this.handlingControl = false; });
      } else this.reportDrop('malformed', `unexpected ${control.t}`);
      return;
    }
    for (const listener of [...this.messageListeners]) {
      try {
        listener(text);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private reportDrop(reason: DropReason, detail: string): void {
    try {
      this.onDrop?.(reason, detail);
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * The channel is ordered and reliable, so a frame that can't be used means the stream has a hole in
   * it — a stall, or a peer sending junk. Staying open would lose a commit without a word (and the copy
   * behind it would quietly stop matching); closed, the session reconnects and starts again from a
   * snapshot.
   */
  private lostFrame(reason: DropReason, detail: string): void {
    this.reportDrop(reason, detail);
    this.teardown(`dropped-${reason}`);
  }

  private refresh(): void {
    if (this.current === 'closed') return;
    if (!this.everOpen) return this.setState('connecting');
    if (this.iceLost) return this.setState('degraded', 'disconnected');
    if (this.congested) return this.setState('degraded', 'congested');
    this.setState('open');
  }

  private setState(state: TransportState, reason?: string): void {
    if (state === this.current) return;
    this.current = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state, reason);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

function parseControl(text: string): Control | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { t, gen, sdp } = value as Partial<Control>;
  if (t !== 'restart-offer' && t !== 'restart-answer') return null;
  if (typeof gen !== 'number' || !Number.isSafeInteger(gen) || gen < 1 || typeof sdp !== 'string' || sdp.length > 64 * 1024) return null;
  return { t, gen, sdp };
}
