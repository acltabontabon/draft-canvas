import { describe, expect, it, vi } from 'vitest';
import {
  LAN_FIRST_CONNECT_ATTEMPTS,
  LAN_GIVE_UP_MS,
  LAN_RETRY_CAP_MS,
  isLanToken,
  keepLanGuestConnected,
  lanLinks,
  lanRetryDelay,
  lanTokenFromPayload,
  linkLabel,
  newLanToken,
  urlHost,
  type CollabTransport,
  type LanReconnectOptions,
  type TransportState,
} from '../../src/collab/lan';
import { joinPayloadFromHash } from '../../src/lib/joinFragment';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('LAN links', () => {
  it('makes 128-bit tokens in the form the relay requires', () => {
    const tokens = new Set(Array.from({ length: 50 }, newLanToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(isLanToken(token)).toBe(true);
    expect(isLanToken('0123456789ABCDEF0123456789ABCDEF')).toBe(false);
    expect(isLanToken('0123')).toBe(false);
  });

  it('builds one link per address, best first, with IPv6 in brackets', () => {
    expect(lanLinks(49152, ['192.168.1.20', 'fd00::5', '10.0.0.7', '2001:db8::1'], TOKEN)).toEqual([
      `http://192.168.1.20:49152/#join=lan.${TOKEN}`,
      `http://[fd00::5]:49152/#join=lan.${TOKEN}`,
      `http://10.0.0.7:49152/#join=lan.${TOKEN}`,
      `http://[2001:db8::1]:49152/#join=lan.${TOKEN}`,
    ]);
    expect(urlHost('fd00::5')).toBe('[fd00::5]');
    expect(urlHost('[fd00::5]')).toBe('[fd00::5]');
    expect(urlHost('192.168.1.20')).toBe('192.168.1.20');
  });

  it('leaves out duplicates and addresses no browser could open', () => {
    expect(lanLinks(8080, ['192.168.1.20', '192.168.1.20', 'not an address', ''], TOKEN)).toEqual([
      `http://192.168.1.20:8080/#join=lan.${TOKEN}`,
    ]);
    expect(lanLinks(8080, [], TOKEN)).toEqual([]);
    expect(() => lanLinks(8080, ['192.168.1.20'], 'nope')).toThrow();
  });

  it('carries the token to the app’s join flow and back', () => {
    const [link] = lanLinks(49152, ['fd00::5'], TOKEN);
    const payload = joinPayloadFromHash(new URL(link!).hash);
    expect(payload).toBe(`lan.${TOKEN}`);
    expect(lanTokenFromPayload(payload!)).toBe(TOKEN);
    expect(lanTokenFromPayload(`lan.${TOKEN.toUpperCase()}`)).toBe(TOKEN);
    expect(lanTokenFromPayload('1.AAAA')).toBeNull();
    expect(lanTokenFromPayload('lan.short')).toBeNull();
    expect(linkLabel(link!)).toBe('[fd00::5]:49152');
  });
});

describe('LAN retry schedule', () => {
  it('doubles from half a second up to 15 s, with jitter between half and all of it', () => {
    const low = Array.from({ length: 8 }, (_, attempt) => lanRetryDelay(attempt, () => 0));
    const high = Array.from({ length: 8 }, (_, attempt) => lanRetryDelay(attempt, () => 1));
    expect(high).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    expect(low).toEqual([250, 500, 1000, 2000, 4000, 7500, 7500, 7500]);
    expect(lanRetryDelay(1000, () => 1)).toBe(LAN_RETRY_CAP_MS);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = lanRetryDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(low[Math.min(attempt, 7)]!);
      expect(delay).toBeLessThanOrEqual(high[Math.min(attempt, 7)]!);
    }
  });
});

/** A transport the test opens and closes by hand. */
class FakeTransport implements CollabTransport {
  readonly kind = 'socket';
  state: TransportState = 'connecting';
  private readonly listeners = new Set<(state: TransportState, reason?: string) => void>();
  send(): boolean {
    return this.state !== 'closed';
  }
  onMessage(): () => void {
    return () => {};
  }
  onState(listener: (state: TransportState, reason?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(reason = 'closed'): void {
    this.set('closed', reason);
  }
  set(state: TransportState, reason?: string): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state, reason);
  }
}

function keeper(overrides: Partial<LanReconnectOptions> = {}) {
  let now = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let nextId = 0;
  const opened: FakeTransport[] = [];
  const reconnect = vi.fn();
  const gaveUp = vi.fn();
  const retrying = vi.fn();
  let wanted = true;
  const first = new FakeTransport();
  const handle = keepLanGuestConnected(TOKEN, first, {
    reconnect,
    gaveUp,
    retrying,
    wanted: () => wanted,
    random: () => 1,
    open: (token) => {
      expect(token).toBe(TOKEN);
      const transport = new FakeTransport();
      opened.push(transport);
      return transport;
    },
    clock: {
      now: () => now,
      setTimeout: (run, ms) => {
        const id = (nextId += 1);
        timers.push({ at: now + ms, run, id });
        return id;
      },
      clearTimeout: (id) => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index >= 0) timers.splice(index, 1);
      },
    },
    ...overrides,
  });
  /** Runs the next timer, moving the clock to it. */
  const tick = () => {
    timers.sort((a, b) => a.at - b.at);
    const timer = timers.shift();
    if (!timer) throw new Error('No retry scheduled.');
    now = timer.at;
    timer.run();
  };
  return {
    handle,
    first,
    opened,
    reconnect,
    gaveUp,
    retrying,
    tick,
    timers,
    setWanted: (next: boolean) => void (wanted = next),
    advance: (ms: number) => void (now += ms),
  };
}

describe('keepLanGuestConnected', () => {
  it('reconnects after a drop and starts the schedule over once back', () => {
    const k = keeper();
    k.first.set('open');
    k.first.set('closed', 'connection-lost');
    expect(k.retrying).toHaveBeenLastCalledWith(1, 500);

    k.tick();
    expect(k.reconnect).toHaveBeenCalledWith(k.opened[0]);
    k.opened[0]!.set('closed', 'unreachable');
    expect(k.retrying).toHaveBeenLastCalledWith(2, 1000);
    k.tick();
    k.opened[1]!.set('open');

    k.opened[1]!.set('closed', 'timeout');
    expect(k.retrying).toHaveBeenLastCalledWith(1, 500);
    expect(k.gaveUp).not.toHaveBeenCalled();
  });

  it('is idempotent about being told the connection was lost', () => {
    const k = keeper();
    k.first.set('open');
    k.handle.lost();
    expect(k.timers).toHaveLength(0);
    k.first.set('closed', 'connection-lost');
    k.handle.lost();
    k.handle.lost();
    expect(k.timers).toHaveLength(1);
  });

  it('stops for good when the owner stopped sharing or restarted it', () => {
    for (const reason of ['server-stopped', 'token-changed']) {
      const k = keeper();
      k.first.set('open');
      k.first.set('closed', reason);
      expect(k.gaveUp).toHaveBeenCalledWith('stopped');
      expect(k.timers).toHaveLength(0);
    }
  });

  it('gives a link that never connected only a few tries', () => {
    const k = keeper();
    k.first.set('closed', 'unreachable');
    for (let i = 0; i < LAN_FIRST_CONNECT_ATTEMPTS; i += 1) {
      k.tick();
      k.opened.at(-1)!.set('closed', 'unreachable');
    }
    expect(k.opened).toHaveLength(LAN_FIRST_CONNECT_ATTEMPTS);
    expect(k.gaveUp).toHaveBeenCalledWith('unreachable');
    expect(k.timers).toHaveLength(0);
  });

  it('gives up two minutes after the drop', () => {
    const k = keeper();
    k.first.set('open');
    k.first.set('closed', 'connection-lost');
    let tries = 0;
    while (k.timers.length > 0) {
      k.tick();
      tries += 1;
      k.opened.at(-1)!.set('closed', 'unreachable');
    }
    expect(k.gaveUp).toHaveBeenCalledTimes(1);
    expect(k.gaveUp).toHaveBeenCalledWith('unreachable');
    // 0.5 + 1 + 2 + 4 + 8 + 15 + 15 + … s, all within LAN_GIVE_UP_MS of the drop.
    expect(tries).toBe(11);
    const scheduled = k.retrying.mock.calls.reduce((sum, [, delay]) => sum + (delay as number), 0);
    expect(scheduled).toBeLessThanOrEqual(LAN_GIVE_UP_MS);
  });

  it('stays quiet once the session no longer wants a connection', () => {
    const k = keeper();
    k.first.set('open');
    k.first.set('closed', 'connection-lost');
    k.setWanted(false);
    k.tick();
    expect(k.opened).toHaveLength(0);
    expect(k.reconnect).not.toHaveBeenCalled();
    expect(k.gaveUp).not.toHaveBeenCalled();

    const ended = keeper();
    ended.first.set('open');
    ended.setWanted(false);
    ended.first.set('closed', 'ended');
    expect(ended.timers).toHaveLength(0);
    expect(ended.gaveUp).not.toHaveBeenCalled();
  });

  it('cancels a pending retry on stop', () => {
    const k = keeper();
    k.first.set('open');
    k.first.set('closed', 'connection-lost');
    k.handle.stop();
    expect(k.timers).toHaveLength(0);
    k.handle.lost();
    expect(k.timers).toHaveLength(0);
    expect(k.gaveUp).not.toHaveBeenCalled();
  });
});
