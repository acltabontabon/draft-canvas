import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostLobbyEvents } from '../../src/collab/lobby';
import { newOwnerIdentity } from '../../src/collab/rendezvous';
import { announce } from '../../src/lib/announce';
import { COLLAB_AT_REST, useCollabStore } from '../../src/store/collabStore';
import { closeLobby, openLobby } from '../../src/ui/collab/lobbyStore';

const lobbies = vi.hoisted(() => [] as HostLobbyEvents[]);
vi.mock('../../src/collab/connect', () => ({ relayUrl: () => 'wss://relay.example' }));
vi.mock('../../src/collab/rendezvous', () => ({
  rendezvousAvailable: () => true,
  newOwnerIdentity: vi.fn(),
  newSessionLink: () => ({}),
  sessionPayload: () => 'session',
}));
vi.mock('../../src/collab/lobby', () => ({
  HostLobby: class {
    constructor(...args: unknown[]) { lobbies.push(args[5] as HostLobbyEvents); }
    async open() { lobbies.at(-1)!.status('open'); }
    async close() {}
  },
}));
vi.mock('../../src/lib/announce', () => ({ announce: vi.fn() }));

beforeEach(() => {
  useCollabStore.setState({ ...COLLAB_AT_REST, role: 'host' });
  vi.mocked(newOwnerIdentity).mockResolvedValue({} as never);
});

afterEach(() => {
  closeLobby();
  useCollabStore.setState(COLLAB_AT_REST);
  lobbies.length = 0;
  vi.resetAllMocks();
});

describe('lobby UI lifetime', () => {
  it('does not let an older identity failure disable a newer lobby', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(newOwnerIdentity).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    openLobby('Old owner');
    openLobby('Owner');
    await Promise.resolve();
    expect(useCollabStore.getState().rendezvous).toBe('open');
    fail(new Error('Old request failed'));
    await Promise.resolve();
    expect(useCollabStore.getState().rendezvous).toBe('open');
    expect(useCollabStore.getState().sessionLink).not.toBeNull();
  });

  it('forgets announcements when requests leave the bounded waiting room', async () => {
    openLobby('Owner');
    await Promise.resolve();
    const events = lobbies[0]!;
    const knock = { id: 'request', name: 'Guest', at: 0 };
    events.knocks([knock]);
    events.knocks([knock]);
    expect(announce).toHaveBeenCalledTimes(1);
    events.knocks([]);
    events.knocks([knock]);
    expect(announce).toHaveBeenCalledTimes(2);
  });
});
