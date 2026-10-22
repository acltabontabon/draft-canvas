import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLanSharing, type LanRelay, type LanRelayEvent } from '../../src/collab/lan';
import { LAN_DEGRADE_MS, LanHostRelay, type LanRelayLink } from '../../src/collab/transport/lanHost';
import type { CollabTransport, TransportState } from '../../src/collab/transport/types';

/** The shell's two commands, answered when the test says so. */
function fakeLink() {
  const sends: { connId: string; text: string; resolve(): void; reject(error: Error): void }[] = [];
  const closes: { connId: string; reason: string }[] = [];
  const link: LanRelayLink = {
    send: (connId, text) =>
      new Promise<void>((resolve, reject) => {
        sends.push({ connId, text, resolve, reject });
      }),
    close: async (connId, reason) => {
      closes.push({ connId, reason });
    },
  };
  return { link, sends, closes };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function record(transport: CollabTransport) {
  const states: [TransportState, string | undefined][] = [];
  const messages: string[] = [];
  transport.onState((state, reason) => states.push([state, reason]));
  transport.onMessage((message) => messages.push(message));
  return { states, messages };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LAN host relay adapter', () => {
  it('turns each relay connection into an open transport and routes its messages', () => {
    const { link } = fakeLink();
    const connections: CollabTransport[] = [];
    const relay = new LanHostRelay(link, { connection: (transport) => connections.push(transport) });

    relay.handle({ type: 'collab-lan-open', connId: 'a' });
    relay.handle({ type: 'collab-lan-open', connId: 'b' });
    const [a, b] = connections.map(record);
    expect(connections.map((transport) => [transport.kind, transport.state])).toEqual([
      ['socket', 'open'],
      ['socket', 'open'],
    ]);

    relay.handle({ type: 'collab-lan-message', connId: 'b', text: 'hello from b' });
    relay.handle({ type: 'collab-lan-message', connId: 'nobody', text: 'stray' });
    expect(a!.messages).toEqual([]);
    expect(b!.messages).toEqual(['hello from b']);
    expect(relay.size).toBe(2);
  });

  it('sends to one guest one at a time, in order', async () => {
    const { link, sends } = fakeLink();
    let transport!: CollabTransport;
    const relay = new LanHostRelay(link, { connection: (next) => (transport = next) });
    relay.handle({ type: 'collab-lan-open', connId: 'a' });

    transport.send('one', 'commit');
    transport.send('two', 'commit');
    transport.send('three', 'commit');
    expect(sends.map((send) => send.text)).toEqual(['one']);

    sends[0]!.resolve();
    await flush();
    expect(sends.map((send) => send.text)).toEqual(['one', 'two']);
    sends[1]!.resolve();
    await flush();
    sends[2]!.resolve();
    await flush();
    expect(sends.map((send) => [send.connId, send.text])).toEqual([
      ['a', 'one'],
      ['a', 'two'],
      ['a', 'three'],
    ]);
  });

  it('closes a guest only after what was already sent has gone', async () => {
    const { link, sends, closes } = fakeLink();
    let transport!: CollabTransport;
    const relay = new LanHostRelay(link, { connection: (next) => (transport = next) });
    relay.handle({ type: 'collab-lan-open', connId: 'a' });
    const { states } = record(transport);

    transport.send('{"t":"end"}', 'commit');
    transport.close('ended');
    expect(states).toEqual([['closed', 'ended']]);
    expect(transport.send('late', 'commit')).toBe(false);
    expect(closes).toEqual([]);

    sends[0]!.resolve();
    await flush();
    expect(closes).toEqual([{ connId: 'a', reason: 'ended' }]);
    expect(relay.size).toBe(0);
  });

  it('closes with the relay’s reason and drops what was waiting', async () => {
    const { link, sends, closes } = fakeLink();
    let transport!: CollabTransport;
    const relay = new LanHostRelay(link, { connection: (next) => (transport = next) });
    relay.handle({ type: 'collab-lan-open', connId: 'a' });
    const { states, messages } = record(transport);
    transport.send('one', 'commit');
    transport.send('two', 'commit');

    relay.handle({ type: 'collab-lan-close', connId: 'a', reason: 'timeout' });
    relay.handle({ type: 'collab-lan-message', connId: 'a', text: 'late' });
    sends[0]!.resolve();
    await flush();

    expect(states).toEqual([['closed', 'timeout']]);
    expect(messages).toEqual([]);
    expect(sends.map((send) => send.text)).toEqual(['one']);
    expect(closes).toEqual([]);
  });

  it('drops presence once a backlog builds up, never commits, and degrades if it stays', async () => {
    const { link, sends } = fakeLink();
    let transport!: CollabTransport;
    const relay = new LanHostRelay(link, { connection: (next) => (transport = next) });
    relay.handle({ type: 'collab-lan-open', connId: 'a' });
    const { states } = record(transport);

    expect(transport.send('pointer', 'presence')).toBe(true);
    expect(transport.send('x'.repeat(100_000), 'commit')).toBe(true);
    expect(transport.send('pointer', 'presence')).toBe(false);
    expect(transport.send('patch', 'commit')).toBe(true);

    vi.advanceTimersByTime(LAN_DEGRADE_MS);
    expect(states).toEqual([['degraded', 'congested']]);

    for (let i = 0; i < 3; i += 1) {
      sends[i]!.resolve();
      await flush();
    }
    expect(sends.map((send) => send.text.slice(0, 7))).toEqual(['pointer', 'xxxxxxx', 'patch']);
    expect(transport.state).toBe('open');
    expect(transport.send('pointer', 'presence')).toBe(true);
  });

  it('closes a guest whose message couldn’t be sent, since it is out of step now', async () => {
    const { link, sends, closes } = fakeLink();
    let transport!: CollabTransport;
    const relay = new LanHostRelay(link, { connection: (next) => (transport = next) });
    relay.handle({ type: 'collab-lan-open', connId: 'a' });
    const { states } = record(transport);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    transport.send('one', 'commit');
    transport.send('two', 'commit');
    sends[0]!.reject(new Error('too large'));
    await flush();

    expect(states).toEqual([['closed', 'send-failed']]);
    expect(closes).toEqual([{ connId: 'a', reason: 'send-failed' }]);
    expect(sends).toHaveLength(1);
  });

  it('closes everyone when the relay stops', () => {
    const { link } = fakeLink();
    const connections: CollabTransport[] = [];
    const stopped = vi.fn();
    const relay = new LanHostRelay(link, { connection: (transport) => connections.push(transport), stopped });
    relay.handle({ type: 'collab-lan-open', connId: 'a' });
    relay.handle({ type: 'collab-lan-open', connId: 'b' });
    const recorded = connections.map(record);

    relay.handle({ type: 'collab-lan-stopped', reason: 'window-closed' });

    expect(recorded.map((entry) => entry.states)).toEqual([[['closed', 'window-closed']], [['closed', 'window-closed']]]);
    expect(stopped).toHaveBeenCalledWith('window-closed');
    expect(relay.size).toBe(0);
  });
});

describe('startLanSharing', () => {
  function fakeRelay(started = { port: 49152, addresses: ['192.168.1.20', 'fd00::5'] }) {
    const listeners = new Set<(event: LanRelayEvent) => void>();
    const relay = {
      start: vi.fn(async (_token: string) => started),
      stop: vi.fn(async () => {}),
      send: vi.fn(async (_connId: string, _text: string) => {}),
      close: vi.fn(async (_connId: string, _reason: string) => {}),
      subscribe: vi.fn((listener: (event: LanRelayEvent) => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      }),
    } satisfies LanRelay;
    const emit = (event: LanRelayEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    return { relay, emit, listeners };
  }

  it('starts the relay with a fresh token and hands out a link per address', async () => {
    const { relay } = fakeRelay();
    const sharing = await startLanSharing(relay, { onTransport: () => {} });
    expect(sharing.token).toMatch(/^[0-9a-f]{32}$/);
    expect(relay.start).toHaveBeenCalledWith(sharing.token);
    expect(sharing.links).toEqual([
      `http://192.168.1.20:49152/#join=lan.${sharing.token}`,
      `http://[fd00::5]:49152/#join=lan.${sharing.token}`,
    ]);
    const again = await startLanSharing(fakeRelay().relay, { onTransport: () => {} });
    expect(again.token).not.toBe(sharing.token);
  });

  it('routes guests to the session and closes them all on stop', async () => {
    const { relay, emit, listeners } = fakeRelay();
    const transports: CollabTransport[] = [];
    const sharing = await startLanSharing(relay, { onTransport: (transport) => transports.push(transport) });

    emit({ type: 'collab-lan-open', connId: 'a' });
    expect(transports).toHaveLength(1);
    expect(sharing.connections).toBe(1);
    const { states } = record(transports[0]!);

    await sharing.stop();
    await sharing.stop();
    expect(states).toEqual([['closed', 'stopped']]);
    expect(relay.stop).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('says when the relay stopped by itself', async () => {
    const { relay, emit, listeners } = fakeRelay();
    const onStopped = vi.fn();
    const sharing = await startLanSharing(relay, { onTransport: () => {}, onStopped });
    emit({ type: 'collab-lan-stopped', reason: 'window-closed' });
    expect(onStopped).toHaveBeenCalledWith('window-closed');
    expect(listeners.size).toBe(0);
    await sharing.stop();
    expect(relay.stop).not.toHaveBeenCalled();
  });

  it('passes on the shell’s refusal and leaves nothing listening', async () => {
    const { relay, listeners } = fakeRelay();
    relay.start.mockRejectedValueOnce(new Error('The port is in use.'));
    await expect(startLanSharing(relay, { onTransport: () => {} })).rejects.toThrow('The port is in use.');
    expect(listeners.size).toBe(0);
  });

  it('refuses a token the relay would reject', async () => {
    const { relay } = fakeRelay();
    await expect(startLanSharing(relay, { onTransport: () => {}, token: 'ABC' })).rejects.toThrow('32 lowercase hex');
    expect(relay.start).not.toHaveBeenCalled();
  });
});
