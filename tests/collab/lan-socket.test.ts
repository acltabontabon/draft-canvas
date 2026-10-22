import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_BYTES } from '../../src/collab/protocol';
import {
  LAN_PROTOCOL,
  SOCKET_CONNECT_TIMEOUT_MS,
  SOCKET_DEGRADE_MS,
  SOCKET_HIGH_WATERMARK,
  SOCKET_LOW_WATERMARK,
  closeReason,
  lanSocketUrl,
  openSocketTransport,
  type SocketLike,
} from '../../src/collab/transport/socket';
import type { TransportState } from '../../src/collab/transport/types';

const TOKEN = '0123456789abcdef0123456789abcdef';

/** Just enough of a browser WebSocket: the test plays the relay's side. */
class FakeSocket extends EventTarget implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  protocol = '';
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new DOMException('Not open', 'InvalidStateError');
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  /** The relay accepts the upgrade. */
  accept(protocol = LAN_PROTOCOL): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.dispatchEvent(new Event('open'));
  }
  frame(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  drop(code: number, reason = ''): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }
}

let sockets: FakeSocket[];

function open() {
  const transport = openSocketTransport('ws://192.168.1.20:49152/collab', TOKEN, {
    socket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
  });
  const states: [TransportState, string | undefined][] = [];
  const messages: string[] = [];
  transport.onState((state, reason) => states.push([state, reason]));
  transport.onMessage((message) => messages.push(message));
  return { transport, socket: sockets.at(-1)!, states, messages };
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LAN socket transport', () => {
  it('connects to the page’s own relay, offering the protocol and the token', () => {
    expect(lanSocketUrl({ protocol: 'http:', host: '192.168.1.20:49152' })).toBe('ws://192.168.1.20:49152/collab');
    expect(lanSocketUrl({ protocol: 'https:', host: '[fd00::5]:8443' })).toBe('wss://[fd00::5]:8443/collab');
    const { socket, transport } = open();
    expect(socket.protocols).toEqual([LAN_PROTOCOL, TOKEN]);
    expect(transport.kind).toBe('socket');
    expect(transport.state).toBe('connecting');
  });

  it('holds commits until it opens, drops presence meanwhile, then sends in order', () => {
    const { transport, socket, states } = open();
    expect(transport.send('hello', 'commit')).toBe(true);
    expect(transport.send('pointer', 'presence')).toBe(false);
    expect(transport.send('patch-1', 'commit')).toBe(true);
    expect(socket.sent).toEqual([]);

    socket.accept();

    expect(socket.sent).toEqual(['hello', 'patch-1']);
    expect(states).toEqual([['open', undefined]]);
    expect(transport.send('pointer', 'presence')).toBe(true);
    expect(socket.sent.at(-1)).toBe('pointer');
  });

  it('delivers text frames and ignores anything else', () => {
    const { socket, messages } = open();
    socket.accept();
    socket.frame('{"t":"welcome"}');
    socket.frame(new ArrayBuffer(4));
    expect(messages).toEqual(['{"t":"welcome"}']);
  });

  it('refuses a server that answers with another protocol', () => {
    const { socket, states } = open();
    socket.accept('something-else');
    expect(states.at(-1)).toEqual(['closed', 'protocol']);
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'protocol' });
  });

  it('names why it closed: the relay’s reason, or what the browser could tell', () => {
    const never = open();
    never.socket.drop(1006);
    expect(never.states).toEqual([['closed', 'unreachable']]);

    const changed = open();
    changed.socket.accept();
    changed.socket.drop(1008, 'token-changed');
    expect(changed.states.at(-1)).toEqual(['closed', 'token-changed']);

    const lost = open();
    lost.socket.accept();
    lost.socket.drop(1006);
    expect(lost.states.at(-1)).toEqual(['closed', 'connection-lost']);
    expect(lost.transport.send('x', 'commit')).toBe(false);
  });

  it('gives up on a relay that never answers', () => {
    const { socket, states } = open();
    vi.advanceTimersByTime(SOCKET_CONNECT_TIMEOUT_MS);
    expect(states).toEqual([['closed', 'connect-timeout']]);
    expect(socket.closedWith?.code).toBe(1000);
  });

  it('drops presence under backpressure, queues commits, and degrades if the backlog stays', () => {
    const { transport, socket, states } = open();
    socket.accept();

    socket.bufferedAmount = SOCKET_LOW_WATERMARK + 1;
    expect(transport.send('pointer', 'presence')).toBe(false);
    expect(transport.send('patch-1', 'commit')).toBe(true);
    expect(socket.sent).toEqual(['patch-1']);

    socket.bufferedAmount = SOCKET_HIGH_WATERMARK + 1;
    expect(transport.send('patch-2', 'commit')).toBe(true);
    expect(transport.send('patch-3', 'commit')).toBe(true);
    expect(socket.sent).toEqual(['patch-1']);

    vi.advanceTimersByTime(SOCKET_DEGRADE_MS);
    expect(transport.state).toBe('degraded');
    expect(states.at(-1)).toEqual(['degraded', 'congested']);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(socket.sent).toEqual(['patch-1', 'patch-2', 'patch-3']);
    expect(transport.state).toBe('open');
    expect(transport.send('pointer', 'presence')).toBe(true);
  });

  it('never sends a message past the limit', () => {
    const { transport, socket } = open();
    socket.accept();
    expect(() => transport.send('x'.repeat(MAX_MESSAGE_BYTES + 1), 'commit')).toThrow(RangeError);
    // Under the cap in UTF-16 units but over it in UTF-8 bytes.
    expect(() => transport.send('é'.repeat(MAX_MESSAGE_BYTES / 2 + 1), 'commit')).toThrow(RangeError);
    expect(socket.sent).toEqual([]);
  });

  it('closes cleanly: one closed state, then silence', () => {
    const { transport, socket, states, messages } = open();
    socket.accept();
    transport.close('ended');
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'ended' });
    socket.frame('late');
    socket.drop(1000, 'closed');
    expect(states).toEqual([
      ['open', undefined],
      ['closed', 'ended'],
    ]);
    expect(messages).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cuts a close reason to what a close frame carries, without splitting a character', () => {
    expect(closeReason('ended')).toBe('ended');
    const cut = closeReason('é'.repeat(100));
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(123);
    expect(cut).toBe('é'.repeat(61));
  });
});
