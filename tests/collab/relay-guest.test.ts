import { afterEach, describe, expect, it, vi } from 'vitest';
import { knock } from '../../src/collab/lobby';
import type { SessionLink } from '../../src/collab/rendezvous';
import { guestSession, leaveSessionKeepingView, reconnectSession } from '../../src/store/collabBridge';
import { COLLAB_AT_REST, useCollabStore } from '../../src/store/collabStore';
import { rejoinByRelay } from '../../src/ui/collab/relayGuest';

vi.mock('../../src/collab/lobby', () => ({ knock: vi.fn() }));
vi.mock('../../src/store/collabBridge', () => ({ guestSession: vi.fn(), leaveSessionKeepingView: vi.fn(), reconnectSession: vi.fn() }));

const link = {} as SessionLink;
const oldSession = { id: 'old', resumeKey: 'old-secret', isEnded: false };
const nextSession = { id: 'next', resumeKey: 'next-secret', isEnded: false };

function setup() {
  vi.useFakeTimers();
  useCollabStore.setState({ ...COLLAB_AT_REST, role: 'guest', status: 'reconnecting' });
  vi.mocked(guestSession).mockReturnValue(oldSession as never);
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  useCollabStore.setState(COLLAB_AT_REST);
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('relay reconnects belong to one session', () => {
  it('never retries a later session against the old owner', async () => {
    setup();
    vi.mocked(knock).mockRejectedValue(new Error('Offline'));
    rejoinByRelay(link, 'relay', 'Guest', '')();
    await flush();
    expect(knock).toHaveBeenCalledTimes(1);
    vi.mocked(guestSession).mockReturnValue(nextSession as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(knock).toHaveBeenCalledTimes(1);
    expect(reconnectSession).not.toHaveBeenCalled();
    expect(leaveSessionKeepingView).not.toHaveBeenCalled();
  });

  it('cancels an old knock still being prepared and closes its late connection', async () => {
    setup();
    let finish!: (pending: Awaited<ReturnType<typeof knock>>) => void;
    vi.mocked(knock).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    rejoinByRelay(link, 'relay', 'Guest', '')();
    const cancel = vi.fn();
    const close = vi.fn();
    vi.mocked(guestSession).mockReturnValue(nextSession as never);
    finish({ cancel, transport: Promise.resolve({ close }) } as never);
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('cancelled');
    expect(reconnectSession).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a connection arriving after another session replaced a pending knock', async () => {
    setup();
    let connect!: (transport: unknown) => void;
    const cancel = vi.fn();
    vi.mocked(knock).mockResolvedValue({ cancel, transport: new Promise((resolve) => { connect = resolve; }) } as never);
    rejoinByRelay(link, 'relay', 'Guest', '')();
    await flush();
    vi.mocked(guestSession).mockReturnValue(nextSession as never);
    // The replacement can itself be reconnecting, so checking status alone cannot distinguish it.
    useCollabStore.setState({ selfId: 'next' });
    const close = vi.fn();
    connect({ close });
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('cancelled');
    expect(reconnectSession).not.toHaveBeenCalled();
    expect(leaveSessionKeepingView).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
