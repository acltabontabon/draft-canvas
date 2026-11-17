import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostLobbyEvents } from '../../src/collab/lobby';
import { newOwnerIdentity } from '../../src/collab/rendezvous';
import { announce } from '../../src/lib/announce';
import { COLLAB_AT_REST, useCollabStore } from '../../src/store/collabStore';
import { useEditorStore } from '../../src/store/editorStore';
import { useUiStore } from '../../src/store/uiStore';
import { closeLobby, openLobby } from '../../src/ui/collab/lobbyStore';

const lobbies = vi.hoisted(() => [] as HostLobbyEvents[]);
const answers = vi.hoisted(() => ({ allow: vi.fn(), deny: vi.fn() }));
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
    async allow(id: string, role: string) { answers.allow(id, role); }
    async deny(id: string) { answers.deny(id); }
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

  // #176: the presenter's notice had one "Let in", which always granted editing.
  it('offers every answer, by the access it grants, while presenting', async () => {
    const mode = useEditorStore.getState().mode;
    useEditorStore.setState({ mode: 'present' });
    try {
      openLobby('Owner');
      await Promise.resolve();
      lobbies[0]!.knocks([{ id: 'request', name: 'Guest', at: 0 }]);
      const toast = useUiStore.getState().toasts.at(-1)!;
      expect(toast.message).toBe('Guest wants to join');
      const actions = [toast.action!, ...toast.alternatives!];
      expect(actions.map((action) => action.label)).toEqual(['Can edit', 'Can view', 'Deny']);
      actions[1]!.run();
      expect(answers.allow).toHaveBeenCalledWith('request', 'viewer');
      actions[2]!.run();
      expect(answers.deny).toHaveBeenCalledWith('request');
      useUiStore.getState().dismiss(toast.id);
    } finally {
      useEditorStore.setState({ mode });
    }
  });
});
