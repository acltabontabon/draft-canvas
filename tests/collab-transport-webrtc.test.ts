import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrames } from '../src/collab/transport/chunk';
import { CollabCodeError } from '../src/collab/transport/invite';
import {
  BUFFER_HIGH_WATERMARK,
  BUFFER_LOW_WATERMARK,
  CLOSE_DRAIN_MS,
  CONGESTION_DEGRADE_MS,
  ICE_GATHER_TIMEOUT_MS,
  ICE_RESTART_GIVE_UP_MS,
  createHostOffer,
  joinFromInvite,
  type WebRtcOptions,
} from '../src/collab/transport/webrtc';
import type { CollabTransport, IceConfig, TransportState } from '../src/collab/transport/types';

/*
 * A fake of just enough RTCPeerConnection to run the real handshake, framing and recovery logic.
 * Two fakes find each other by ICE ufrag, the way the real ones find each other by candidates:
 * once the offerer applies an answer whose ufrag belongs to another fake, the two are linked,
 * report 'connected', and open their channels.
 */

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => ((i * 9) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':');
const byUfrag = new Map<string, FakePeerConnection>();
let counter = 0;
/**
 * Whether the path between the two fakes carries packets. A connection that goes 'disconnected' because
 * the network really changed carries nothing — the data channel included, so nothing signalled over it
 * arrives until the path is back.
 */
const network = { down: false };

function sdp(ufrag: string, pwd: string, setup: string, candidates: string[]): string {
  return [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    ...candidates,
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:sha-256 ${FINGERPRINT}`, `a=setup:${setup}`,
    'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
  ].join('\r\n');
}

function ufragOf(text: string): string {
  return /a=ice-ufrag:(\S+)/.exec(text)![1]!;
}

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  peer: FakeChannel | null = null;
  /** While paused, sends stay in the buffer, as they would on a congested link. */
  paused = false;
  /** Every frame handed to `send`, for size assertions. */
  readonly sent: Uint8Array[] = [];
  private readonly outbox: ArrayBuffer[] = [];
  readonly init: RTCDataChannelInit;

  constructor(init: RTCDataChannelInit) {
    super();
    this.init = init;
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 'open') throw new DOMException('The channel is not open.', 'InvalidStateError');
    this.sent.push(data);
    this.outbox.push(data.slice().buffer);
    this.bufferedAmount += data.length;
    if (!this.paused && !network.down) queueMicrotask(() => this.flush());
  }

  /** Delivers everything buffered, then signals the drop below the threshold. */
  flush(): void {
    const before = this.bufferedAmount;
    while (this.outbox.length && !this.paused && !network.down) {
      const data = this.outbox.shift()!;
      this.bufferedAmount -= data.byteLength;
      if (this.peer?.readyState === 'open') this.peer.dispatchEvent(new MessageEvent('message', { data }));
    }
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }

  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer && peer.readyState !== 'closed') {
        peer.readyState = 'closed';
        peer.dispatchEvent(new Event('close'));
      }
    });
  }
}

interface FakeBehaviour {
  /** Gathering never finishes on its own, to exercise the 5 s cap. */
  slowGathering?: boolean;
  /** Linking on answer is automatic unless this is set. */
  manualConnect?: boolean;
  maxMessageSize?: number;
}

const behaviour: FakeBehaviour = {};

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  readonly configuration: RTCConfiguration;
  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly sctp: { maxMessageSize: number };
  channel: FakeChannel | null = null;
  peer: FakePeerConnection | null = null;
  readonly remoteHistory: RTCSessionDescriptionInit[] = [];
  readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
  private generation = 0;
  private readonly id = ++counter;

  constructor(configuration: RTCConfiguration) {
    super();
    this.configuration = configuration;
    this.sctp = { maxMessageSize: behaviour.maxMessageSize ?? 262144 };
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(_label: string, init: RTCDataChannelInit): FakeChannel {
    this.channel = new FakeChannel(init);
    return this.channel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
    return { type: 'offer', sdp: this.describe('actpass') };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: this.describe('active') };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    byUfrag.set(ufragOf(description.sdp!), this);
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    this.iceGatheringState = 'gathering';
    this.dispatchEvent(new Event('icegatheringstatechange'));
    if (behaviour.slowGathering) return;
    queueMicrotask(() => {
      this.iceGatheringState = 'complete';
      this.dispatchEvent(new Event('icegatheringstatechange'));
      this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }));
    });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (!/a=ice-ufrag:/.test(description.sdp ?? '')) throw new DOMException('Bad SDP', 'OperationError');
    this.remoteDescription = description;
    this.remoteHistory.push(description);
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (description.type === 'answer') {
      const peer = byUfrag.get(ufragOf(description.sdp!));
      if (peer && !behaviour.manualConnect) link(this, peer);
    }
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  close(): void {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
    this.channel?.close();
  }

  private describe(setup: string): string {
    this.generation++;
    const ufrag = `u${this.id.toString(36)}g${this.generation}`.padEnd(4, 'x');
    return sdp(ufrag, `p${this.id}`.padEnd(24, 'w'), setup, [`a=candidate:1 1 udp 2113937151 192.0.2.${this.id % 250} ${50000 + this.id} typ host`]);
  }
}

function link(a: FakePeerConnection, b: FakePeerConnection): void {
  a.peer = b;
  b.peer = a;
  a.channel!.peer = b.channel;
  b.channel!.peer = a.channel;
  for (const pc of [a, b]) {
    if (pc.connectionState !== 'connected') pc.setConnectionState('connected');
  }
  a.channel!.open();
  b.channel!.open();
}

const LOCAL: IceConfig = { servers: [{ urls: 'stun:stun.example.org' }], localOnly: true };
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
let clock = NOW;
const drops: string[] = [];
const options: WebRtcOptions = {
  peerConnection: FakePeerConnection as unknown as WebRtcOptions['peerConnection'],
  now: () => clock,
  onDrop: (reason, detail) => drops.push(`${reason}: ${detail}`),
};

async function connect(config = LOCAL): Promise<{ host: CollabTransport; guest: CollabTransport; hostPc: FakePeerConnection; guestPc: FakePeerConnection }> {
  const offer = await createHostOffer(config, options);
  const join = await joinFromInvite(offer.invitePayload, config, options);
  const host = await offer.acceptReply(join.replyCode);
  const guest = await join.transport;
  const [hostPc, guestPc] = FakePeerConnection.instances.slice(-2) as [FakePeerConnection, FakePeerConnection];
  return { host, guest, hostPc, guestPc };
}

function inbox(transport: CollabTransport): string[] {
  const received: string[] = [];
  transport.onMessage((message) => received.push(message));
  return received;
}

function states(transport: CollabTransport): string[] {
  const seen: string[] = [];
  transport.onState((state: TransportState, reason?: string) => seen.push(reason ? `${state}:${reason}` : state));
  return seen;
}

const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

beforeEach(() => {
  FakePeerConnection.instances = [];
  byUfrag.clear();
  drops.length = 0;
  network.down = false;
  clock = NOW;
  for (const key of Object.keys(behaviour) as (keyof FakeBehaviour)[]) delete behaviour[key];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signaling', () => {
  it('connects an owner and a collaborator through an invite and a reply code', async () => {
    const { host, guest, hostPc, guestPc } = await connect();
    expect([host.kind, host.state, guest.state]).toEqual(['webrtc', 'open', 'open']);
    // localOnly: no ICE servers at all, even though some were configured.
    expect(hostPc.configuration.iceServers).toEqual([]);
    expect(hostPc.channel!.init).toEqual({ negotiated: true, id: 0, ordered: true });
    expect(guestPc.channel!.binaryType).toBe('arraybuffer');
    // Each side received a rebuilt description carrying the other's credentials.
    expect(ufragOf(guestPc.remoteDescription!.sdp!)).toBe(ufragOf(hostPc.localDescription!.sdp!));
    expect(ufragOf(hostPc.remoteDescription!.sdp!)).toBe(ufragOf(guestPc.localDescription!.sdp!));

    const atGuest = inbox(guest);
    const atHost = inbox(host);
    expect(host.send('{"commit":1}', 'commit')).toBe(true);
    expect(guest.send('{"presence":1}', 'presence')).toBe(true);
    await settle();
    expect(atGuest).toEqual(['{"commit":1}']);
    expect(atHost).toEqual(['{"presence":1}']);
  });

  it('passes ICE servers through when not local-only', async () => {
    const servers = [{ urls: ['turn:turn.example.org'], username: 'u', credential: 'c' }];
    await createHostOffer({ servers, localOnly: false }, options);
    expect(FakePeerConnection.instances[0]!.configuration.iceServers).toEqual(servers);
  });

  it('keeps a mismatched reply retryable, then spends the invite on the right one', async () => {
    const offer = await createHostOffer(LOCAL, options);
    const other = await createHostOffer(LOCAL, options);
    const wrong = await joinFromInvite(other.invitePayload, LOCAL, options);
    await expect(offer.acceptReply(wrong.replyCode)).rejects.toMatchObject({ reason: 'mismatch' });
    await expect(offer.acceptReply('1.garbage')).rejects.toBeInstanceOf(CollabCodeError);
    const right = await joinFromInvite(offer.invitePayload, LOCAL, options);
    await expect(offer.acceptReply(right.replyCode)).resolves.toMatchObject({ state: 'open' });
    await expect(offer.acceptReply(right.replyCode)).rejects.toThrow('already been answered');
  });

  it('refuses a reply once the invite has expired, by the owner’s clock', async () => {
    const offer = await createHostOffer(LOCAL, options);
    const join = await joinFromInvite(offer.invitePayload, LOCAL, options);
    clock = offer.expiresAt + 1;
    await expect(offer.acceptReply(join.replyCode)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('refuses to join from an expired invite', async () => {
    const offer = await createHostOffer(LOCAL, options);
    clock = offer.expiresAt + 60 * 60 * 1000;
    await expect(joinFromInvite(offer.invitePayload, LOCAL, options)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('stops waiting for ICE gathering after 5 s and uses what it has', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    behaviour.slowGathering = true;
    let ready = false;
    const pending = createHostOffer(LOCAL, options).then((offer) => {
      ready = true;
      return offer;
    });
    await vi.advanceTimersByTimeAsync(ICE_GATHER_TIMEOUT_MS - 1);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).invitePayload.startsWith('1.')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an invite: the connection closes and replies are refused', async () => {
    const offer = await createHostOffer(LOCAL, options);
    const join = await joinFromInvite(offer.invitePayload, LOCAL, options);
    offer.cancel();
    expect(FakePeerConnection.instances[0]!.connectionState).toBe('closed');
    await expect(offer.acceptReply(join.replyCode)).rejects.toThrow('cancelled');
    join.cancel();
    await expect(join.transport).rejects.toThrow('cancelled');
  });

  it('closes an answered invite that never connects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    behaviour.manualConnect = true;
    const offer = await createHostOffer(LOCAL, options);
    const join = await joinFromInvite(offer.invitePayload, LOCAL, options);
    const accepted = offer.acceptReply(join.replyCode);
    const outcome = expect(accepted).rejects.toThrow('connect-timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
    join.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a collaborator’s early ICE failure ride until the owner applies the reply', async () => {
    behaviour.manualConnect = true;
    const offer = await createHostOffer(LOCAL, options);
    const join = await joinFromInvite(offer.invitePayload, LOCAL, options);
    const [hostPc, guestPc] = FakePeerConnection.instances as [FakePeerConnection, FakePeerConnection];
    guestPc.setConnectionState('failed');
    const accepted = offer.acceptReply(join.replyCode);
    await settle();
    link(hostPc, guestPc);
    await expect(accepted).resolves.toMatchObject({ state: 'open' });
    await expect(join.transport).resolves.toMatchObject({ state: 'open' });
  });
});

describe('connection state', () => {
  it('maps failed and closed connections to closed, with a reason', async () => {
    const first = await connect();
    const seen = states(first.host);
    first.hostPc.setConnectionState('failed');
    expect(seen).toEqual(['closed:failed']);
    expect(first.hostPc.connectionState).toBe('closed');

    const second = await connect();
    const seenGuest = states(second.guest);
    second.guestPc.setConnectionState('closed');
    expect(seenGuest).toEqual(['closed:peer-closed']);
  });

  it('tells the other side when one side closes, and leaves nothing running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, guest, hostPc } = await connect();
    const seenGuest = states(guest);
    const atHost = inbox(host);
    host.close('done');
    host.close('again');
    await settle();
    expect(host.state).toBe('closed');
    expect(seenGuest).toEqual(['closed:peer-closed']);
    expect(host.send('late', 'commit')).toBe(false);
    // Listeners are gone: events after close change nothing.
    hostPc.setConnectionState('connected');
    hostPc.channel!.dispatchEvent(new MessageEvent('message', { data: encodeFrames('x', 1)[0]!.buffer }));
    expect(atHost).toEqual([]);
    expect(host.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets what was queued — the goodbye last — reach the other side before the connection goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, guest, hostPc, guestPc } = await connect();
    const seenHost = states(host);
    const seenGuest = states(guest);
    const atGuest = inbox(guest);
    const channel = hostPc.channel!;
    channel.paused = true;
    const big = 'x'.repeat(200 * 1024);
    for (let i = 0; i < 8; i++) host.send(`${i}:${big}`, 'commit');
    host.send('{"t":"end","reason":"removed"}', 'commit');
    host.close('removed');
    // Closed for the session at once; nothing more can be sent.
    expect(host.state).toBe('closed');
    expect(seenHost).toEqual(['closed:removed']);
    expect(host.send('late', 'commit')).toBe(false);
    expect(hostPc.connectionState).toBe('connected');

    channel.paused = false;
    while (channel.bufferedAmount > 0) {
      channel.flush();
      await settle();
    }
    expect(atGuest).toHaveLength(9);
    expect(atGuest.at(-1)).toBe('{"t":"end","reason":"removed"}');
    // Drained: now the connection goes, and the other side hears it close.
    expect(hostPc.connectionState).toBe('closed');
    await settle();
    expect(guestPc.channel!.readyState).toBe('closed');
    expect(seenGuest).toEqual(['closed:peer-closed']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops draining after a while when the other side is not reading', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, hostPc } = await connect();
    hostPc.channel!.paused = true;
    host.send('x'.repeat(2 * BUFFER_HIGH_WATERMARK), 'commit');
    host.close('ended');
    await vi.advanceTimersByTimeAsync(CLOSE_DRAIN_MS - 1);
    expect(hostPc.connectionState).toBe('connected');
    await vi.advanceTimersByTimeAsync(1);
    expect(hostPc.connectionState).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a draining connection go at once when it drops', async () => {
    const { host, hostPc } = await connect();
    hostPc.channel!.paused = true;
    host.send('{"t":"end","reason":"ended"}', 'commit');
    host.close('ended');
    hostPc.setConnectionState('disconnected');
    expect(hostPc.connectionState).toBe('closed');
  });

  it('degrades on disconnect and restarts ICE over the data channel once packets cross again', async () => {
    const { host, guest, hostPc, guestPc } = await connect();
    const seenHost = states(host);
    const seenGuest = states(guest);
    const hostRemoteBefore = ufragOf(hostPc.remoteDescription!.sdp!);
    network.down = true;
    hostPc.setConnectionState('disconnected');
    guestPc.setConnectionState('disconnected');
    expect(seenHost).toEqual(['degraded:disconnected']);
    expect(seenGuest).toEqual(['degraded:disconnected']);
    expect(host.send('cursor', 'presence')).toBe(false);
    const atGuest = inbox(guest);
    expect(host.send('{"commit":"during"}', 'commit')).toBe(true);

    await settle();
    // The restart offer is made, but it travels the path that just failed: nothing reaches the guest.
    expect(hostPc.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(guestPc.remoteHistory).toHaveLength(1);

    // The path comes back by itself (a Wi-Fi blip): the offer crosses, and the restart completes.
    network.down = false;
    hostPc.channel!.flush();
    await settle();
    // The owner made a restart offer; the collaborator answered it; the owner applied the answer.
    expect(hostPc.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(guestPc.remoteHistory.at(-1)!.type).toBe('offer');
    expect(hostPc.remoteHistory.at(-1)!.type).toBe('answer');
    expect(ufragOf(hostPc.remoteDescription!.sdp!)).not.toBe(hostRemoteBefore);
    expect(seenHost.at(-1)).toBe('open');
    expect(seenGuest.at(-1)).toBe('open');
    expect(atGuest).toEqual(['{"commit":"during"}']);
    expect(drops).toEqual([]);
  });

  it('gives up when a lost connection does not come back within 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, hostPc, guestPc } = await connect();
    const seen = states(host);
    // A real network change (Wi-Fi to cellular): the restart offer has no way across. A session-link
    // guest is already knocking through the relay by now (`relayGuest.ts`); this is the direct-invite case.
    network.down = true;
    hostPc.setConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(ICE_GATHER_TIMEOUT_MS);
    expect(guestPc.remoteHistory).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ICE_RESTART_GIVE_UP_MS - ICE_GATHER_TIMEOUT_MS - 1);
    expect(host.state).toBe('degraded');
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(['degraded:disconnected', 'closed:reconnect-timeout']);
    expect(hostPc.connectionState).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sending', () => {
  it('drops every queued frame when a multi-frame send overflows the queue', async () => {
    const { host, hostPc } = await connect();
    hostPc.channel!.paused = true;
    const message = 'x'.repeat(16 * 1024 * 1024);
    for (let i = 0; i < 6 && host.state !== 'closed'; i++) host.send(message, 'commit');
    expect(host.state).toBe('closed');
    // The send loop must not recreate a queue after enqueue tears down midway through its frames.
    expect(host).toMatchObject({ queuedBytes: 0, queue: [] });
  });

  it('bounds control traffic that bypasses the host session message budget', async () => {
    const { host, hostPc } = await connect();
    for (let id = 0; id < 9; id++) {
      const text = JSON.stringify({ t: 'restart-answer', gen: 1, sdp: '' });
      for (const frame of encodeFrames(text, id, 'control')) hostPc.channel!.dispatchEvent(new MessageEvent('message', { data: frame.buffer }));
    }
    expect(host.state).toBe('closed');
    expect(drops.at(-1)).toContain('too much ICE restart control traffic');
  });

  it('applies at most one copy of a restart offer while the browser is handling it', async () => {
    const { guest, hostPc, guestPc } = await connect();
    const remoteBefore = guestPc.remoteHistory.length;
    const text = JSON.stringify({ t: 'restart-offer', gen: 1, sdp: hostPc.localDescription!.sdp! });
    for (let id = 0; id < 8; id++) {
      for (const frame of encodeFrames(text, id, 'control')) guestPc.channel!.dispatchEvent(new MessageEvent('message', { data: frame.buffer }));
    }
    await settle();
    expect(guest.state).toBe('open');
    expect(guestPc.remoteHistory).toHaveLength(remoteBefore + 1);
  });

  it('drops presence under backpressure, queues commits, and degrades when congestion lasts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, guest, hostPc } = await connect();
    const seen = states(host);
    const atGuest = inbox(guest);
    const channel = hostPc.channel!;
    channel.paused = true;

    const big = 'x'.repeat(200 * 1024);
    expect(host.send('{"cursor":1}', 'presence')).toBe(true);
    for (let i = 0; i < 12; i++) expect(host.send(`${i}:${big}`, 'commit')).toBe(true);
    // The channel was handed no more than the high watermark (plus the frame that crossed it).
    expect(channel.bufferedAmount).toBeGreaterThan(BUFFER_LOW_WATERMARK);
    expect(channel.bufferedAmount).toBeLessThanOrEqual(BUFFER_HIGH_WATERMARK + 64 * 1024);
    expect(host.send('{"cursor":2}', 'presence')).toBe(false);

    await vi.advanceTimersByTimeAsync(CONGESTION_DEGRADE_MS);
    expect(seen).toEqual(['degraded:congested']);
    expect(host.send('{"cursor":3}', 'presence')).toBe(false);

    channel.paused = false;
    while (channel.bufferedAmount > 0) {
      channel.flush();
      await settle();
    }
    expect(seen).toEqual(['degraded:congested', 'open']);
    expect(atGuest).toHaveLength(13);
    expect(atGuest[0]).toBe('{"cursor":1}');
    expect(atGuest.slice(1).map((message) => message.slice(0, message.indexOf(':')))).toEqual(Array.from({ length: 12 }, (_, i) => String(i)));
    expect(host.send('{"cursor":4}', 'presence')).toBe(true);
    host.close();
    // The cursor still in the buffer leaves first; then nothing is left running.
    await settle();
    expect(hostPc.connectionState).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('chunks to the peer’s message size limit and reassembles on the other side', async () => {
    behaviour.maxMessageSize = 16 * 1024;
    const { host, guest, hostPc } = await connect();
    const atGuest = inbox(guest);
    const text = JSON.stringify({ shapes: 'ü'.repeat(100_000) });
    host.send(text, 'commit');
    await settle();
    expect(atGuest).toEqual([text]);
    expect(hostPc.channel!.sent.length).toBeGreaterThan(10);
    expect(hostPc.channel!.sent.every((frame) => frame.length <= 16 * 1024)).toBe(true);
  });

  it('reports a frame it cannot read and closes, rather than carry on with a hole in the stream', async () => {
    const { guest, guestPc } = await connect();
    const seen = states(guest);
    guestPc.channel!.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1, 2, 3]).buffer }));
    expect(drops.map((drop) => drop.split(':')[0])).toEqual(['malformed']);
    expect(guest.state).toBe('closed');
    expect(seen.at(-1)).toBe('closed:dropped-malformed');
  });

  it('closes when a message stops arriving part-way, so the session starts again from a snapshot', async () => {
    const { guest, guestPc } = await connect();
    vi.useFakeTimers();
    try {
      const [first] = encodeFrames('x'.repeat(5000), 7, 'message', 1024);
      guestPc.channel!.dispatchEvent(new MessageEvent('message', { data: first!.buffer }));
      vi.advanceTimersByTime(15_001);
      expect(drops.map((drop) => drop.split(':')[0])).toEqual(['timeout']);
      expect(guest.state).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still answers an unreadable control frame with nothing worse than a report', async () => {
    const { host, guest, guestPc } = await connect();
    const atGuest = inbox(guest);
    guestPc.channel!.dispatchEvent(new MessageEvent('message', { data: encodeFrames('{"t":"nope"}', 99, 'control')[0]!.buffer }));
    expect(drops.map((drop) => drop.split(':')[0])).toEqual(['malformed']);
    host.send('still fine', 'commit');
    await settle();
    expect(atGuest).toEqual(['still fine']);
  });

  it('keeps delivering when one listener throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host, guest } = await connect();
    guest.onMessage(() => {
      throw new Error('listener bug');
    });
    const atGuest = inbox(guest);
    host.send('hello', 'commit');
    await settle();
    expect(atGuest).toEqual(['hello']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('holds a collaborator to the owner’s smaller message cap', async () => {
    const offer = await createHostOffer(LOCAL, { ...options, maxMessageBytes: 4096 });
    const join = await joinFromInvite(offer.invitePayload, LOCAL, options);
    const host = await offer.acceptReply(join.replyCode);
    const guest = await join.transport;
    const atHost = inbox(host);
    guest.send('x'.repeat(4096), 'commit');
    await settle();
    expect(atHost).toHaveLength(1);
    guest.send('x'.repeat(4097), 'commit');
    await settle();
    expect(drops.map((drop) => drop.split(':')[0])).toEqual(['oversize']);
    expect(host.state).toBe('closed');
  });

  it('refuses a message too large for any peer to accept', async () => {
    const { host } = await connect();
    expect(() => host.send('x'.repeat(16 * 1024 * 1024 + 1), 'commit')).toThrow(RangeError);
  });
});
