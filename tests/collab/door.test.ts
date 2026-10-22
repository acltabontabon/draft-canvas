import { describe, expect, it, vi } from 'vitest';
import { holdAtDoor } from '../../src/collab/door';
import { GuestSession } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { loopbackPair } from './support';

function settle(pump: () => number) {
  for (let i = 0; i < 50 && pump() > 0; i += 1);
}

function guest(transport: ReturnType<typeof loopbackPair>['b']) {
  const state = { file: null as DraftDocument | null, statuses: [] as string[], reasons: [] as (string | undefined)[] };
  const session = new GuestSession(
    {
      readFile: () => state.file!,
      applyRemote: (file) => ((state.file = file), true),
      isBusy: () => false,
      open: (file) => (state.file = file),
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: 'Neighbour',
    },
    {
      status: (status, reason) => {
        state.statuses.push(status);
        state.reasons.push(reason);
      },
      joined: () => {},
      peers: () => {},
      presence: () => {},
      presenter: () => {},
      rejected: () => {},
      unconfirmed: () => {},
      tooLarge: () => {},
    },
  );
  session.connect(transport);
  return { session, state };
}

describe('the local network door', () => {
  it('holds someone until the owner lets them in, then joins them as if nothing waited', async () => {
    let owner = addNodes(createDocument('LAN'), [createNode({ type: 'service', x: 0, y: 0, text: 'A' })]);
    const host = new HostSession(
      { readFile: () => owner, applyRemote: (file) => ((owner = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const { a, b, pump } = loopbackPair();
    const waiting = holdAtDoor(a);
    const neighbour = guest(b);
    settle(pump);
    const door = await waiting;
    expect(door?.name).toBe('Neighbour');
    // Waiting, they are not in the session and have no copy of the diagram.
    expect(neighbour.state.file).toBeNull();
    host.attach(door!.admit(), { role: 'viewer' });
    await Promise.resolve();
    settle(pump);
    expect(neighbour.state.statuses.at(-1)).toBe('live');
    expect(neighbour.state.file!.nodes).toHaveLength(1);
    host.end();
  });

  it('tells someone turned away so, and never lets them see the diagram', async () => {
    vi.useFakeTimers();
    const { a, b, pump } = loopbackPair();
    const waiting = holdAtDoor(a);
    const neighbour = guest(b);
    settle(pump);
    (await waiting)!.refuse();
    settle(pump);
    expect(neighbour.state.reasons.at(-1)).toBe('denied');
    expect(neighbour.state.file).toBeNull();
    vi.useRealTimers();
  });

  it('drops a connection that never says hello', async () => {
    vi.useFakeTimers();
    const { a } = loopbackPair();
    const waiting = holdAtDoor(a, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await waiting).toBeNull();
    expect(a.state).toBe('closed');
    vi.useRealTimers();
  });
});
