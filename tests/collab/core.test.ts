import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { embed, viewOf } from '../../src/depth/tree';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addFlow, addStepToFlow, createFlow } from '../../src/document/flow';
import { addEdges, addNodes, removeElements } from '../../src/document/operations';
import { parseDocument } from '../../src/document/validate';
import type { DraftDocument } from '../../src/document/types';
import { applyChanges } from '../../src/collab/apply';
import { diffFile } from '../../src/collab/diff';
import { HostCore, HOST_ORIGIN } from '../../src/collab/hostCore';
import { repairReferences } from '../../src/collab/repair';
import { Replica, applyPatch } from '../../src/collab/replica';
import { sanitizeChanges } from '../../src/collab/sanitize';
import { randomEdit, rngFrom, seededFile, sharedContent } from './support';

function expectSameShared(actual: DraftDocument, expected: DraftDocument) {
  expect(sharedContent(actual)).toEqual(sharedContent(expected));
}

describe('diffFile / applyChanges', () => {
  it('reproduces any later version of a file from any earlier one', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 30 }), (seed, steps) => {
        const rng = rngFrom(seed);
        const versions = [seededFile(rng, 6)];
        for (let i = 0; i < steps; i += 1) versions.push(randomEdit(versions[versions.length - 1]!, rng));
        const from = versions[Math.floor(rng() * versions.length)]!;
        const to = versions[Math.floor(rng() * versions.length)]!;
        expectSameShared(applyChanges(from, diffFile(from, to)), to);
      }),
      { seed: 20261022, numRuns: 300 },
    );
  });

  it('says nothing about cameras and timestamps', () => {
    const file = seededFile(rngFrom(3), 10);
    const moved = { ...file, viewport: { x: 40, y: 40, zoom: 2 }, metadata: { ...file.metadata, updatedAt: file.metadata.updatedAt + 1000 } };
    expect(diffFile(file, moved)).toEqual([]);
  });

  it('carries a shape moved into another room with everything inside it', () => {
    let file = createDocument('Moves');
    const outer = createNode({ type: 'service', text: 'Outer', x: 0, y: 0 });
    const target = createNode({ type: 'service', text: 'Target', x: 300, y: 0 });
    const inner = createNode({ type: 'component', text: 'Inner', x: 0, y: 0 });
    file = addNodes(file, [outer, target]);
    file = embed(file, [outer.id], { ...viewOf(file, [outer.id])!, nodes: [inner] });

    const moved = embed(
      embed(file, [], { ...file, nodes: file.nodes.filter((node) => node.id !== outer.id) }),
      [target.id],
      { ...viewOf(file, [target.id])!, nodes: [file.nodes.find((node) => node.id === outer.id)!] },
    );
    const changes = diffFile(file, moved);
    expect(changes).toContainEqual({ kind: 'move', target: 'node', id: outer.id, room: target.id });
    expect(changes.some((change) => change.kind === 'node' && change.id === inner.id)).toBe(false);
    expectSameShared(applyChanges(file, changes), moved);
  });

  it('moves a shape into a room owned by a shape added in the same edit', () => {
    let file = createDocument('Owner added');
    const loose = createNode({ type: 'component', text: 'Loose', x: 0, y: 0 });
    file = addNodes(file, [loose]);
    const owner = createNode({ type: 'service', text: 'New owner', x: 300, y: 0 });
    const next = addNodes({ ...file, nodes: [] }, [
      { ...owner, inside: { nodes: [loose], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } },
    ]);
    expectSameShared(applyChanges(file, diffFile(file, next)), next);
  });

  it('moves a shape out of a room whose owner is deleted in the same edit', () => {
    let file = createDocument('Owner deleted');
    const owner = createNode({ type: 'service', text: 'Owner', x: 0, y: 0 });
    const kept = createNode({ type: 'component', text: 'Kept', x: 0, y: 0 });
    file = addNodes(file, [owner]);
    file = embed(file, [owner.id], { ...viewOf(file, [owner.id])!, nodes: [kept] });
    const next = { ...file, nodes: [kept] };
    expectSameShared(applyChanges(file, diffFile(file, next)), next);
  });

  it('skips a change to something that is gone instead of failing the batch', () => {
    let file = createDocument('Skips');
    const a = createNode({ type: 'service', text: 'A', x: 0, y: 0 });
    file = addNodes(file, [a]);
    const result = applyChanges(file, [
      { kind: 'node', id: 'missing', room: 'no-such-room', value: { ...a, id: 'missing' } },
      { kind: 'title', value: 'Renamed' },
    ]);
    expect(result.metadata.title).toBe('Renamed');
    expect(result.nodes).toHaveLength(1);
  });

  it('refuses to nest a shape inside itself', () => {
    let file = createDocument('Cycles');
    const a = createNode({ type: 'service', text: 'A', x: 0, y: 0 });
    const b = createNode({ type: 'service', text: 'B', x: 0, y: 0 });
    file = addNodes(file, [a]);
    file = embed(file, [a.id], { ...viewOf(file, [a.id])!, nodes: [b] });
    expect(applyChanges(file, [{ kind: 'move', target: 'node', id: a.id, room: b.id }])).toBe(file);
  });
});

describe('repairReferences', () => {
  it('leaves a consistent file untouched, by identity', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const file = seededFile(rngFrom(seed), 20);
        expect(repairReferences(file)).toBe(file);
      }),
      { seed: 7, numRuns: 100 },
    );
  });

  it('drops a connector whose shape another person deleted, and the flow step that walked it', () => {
    let file = createDocument('Repairs');
    const a = createNode({ type: 'service', text: 'A', x: 0, y: 0 });
    const b = createNode({ type: 'service', text: 'B', x: 300, y: 0 });
    file = addNodes(file, [a, b]);
    const base = file;
    const edge = createEdge({ source: a.id, target: b.id });
    const flow = createFlow({ title: 'Story' });
    const theirs = addStepToFlow(addFlow(addEdges(base, [edge]), flow), flow.id, edge.id);
    const mine = removeElements(base, [b.id]);

    const merged = repairReferences(applyChanges(applyChanges(base, diffFile(base, mine)), diffFile(base, theirs)));
    expect(merged.edges).toEqual([]);
    expect(merged.flows[0]!.steps).toEqual([]);
    const parsed = parseDocument(JSON.parse(JSON.stringify(merged)));
    expect(parsed.ok && parsed.repairs).toEqual([]);
  });
});

/**
 * The whole protocol over an unreliable schedule: the owner and three collaborators edit at random,
 * patches and commits are delivered late and in bursts, and nothing is lost or duplicated by the
 * transport (which is the transport's job, tested on its own). At the end every copy must equal the
 * owner's, and the owner's file must open without a single repair.
 */
describe('a session', () => {
  it('converges, whatever the interleaving', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 20, max: 120 }), (seed, ticks) => {
        const rng = rngFrom(seed);
        const start = seededFile(rng, 8);
        const host = new HostCore(start);
        let hostFile = start;
        const guests = [0, 1, 2].map((i) => ({
          id: `peer-${i}`,
          ledger: { role: 'editor' as const, lastClientSeq: 0 },
          replica: new Replica(start, 0),
          inbox: [] as { seq?: number; changes?: unknown; clientSeq?: number; ack?: number; origin?: string }[],
          outbox: [] as { clientSeq: number; changes: unknown }[],
        }));
        const broadcast = (commit: { seq: number; changes: unknown; origin: string; clientSeq?: number }) => {
          for (const guest of guests) guest.inbox.push(commit);
        };

        const deliverToHost = (guest: (typeof guests)[number]) => {
          const patch = guest.outbox.shift();
          if (!patch) return;
          const wire = JSON.parse(JSON.stringify(patch.changes));
          const outcome = host.receivePatch(guest.id, guest.ledger, patch.clientSeq, wire);
          if (outcome.commit) {
            hostFile = host.file;
            broadcast(JSON.parse(JSON.stringify(outcome.commit)));
          } else {
            guest.inbox.push({ ack: outcome.ack!.clientSeq });
          }
        };
        const deliverToGuest = (guest: (typeof guests)[number]) => {
          const message = guest.inbox.shift();
          if (!message) return;
          if (message.ack !== undefined) return guest.replica.acknowledge(message.ack);
          const changes = sanitizeChanges(message.changes);
          expect(changes.ok).toBe(true);
          if (!changes.ok) return;
          const own = message.origin === guest.id ? message.clientSeq : undefined;
          expect(guest.replica.receiveCommit(message.seq!, changes.changes, own)).toBe('applied');
        };

        for (let tick = 0; tick < ticks; tick += 1) {
          const roll = rng();
          const guest = guests[Math.floor(rng() * guests.length)]!;
          if (roll < 0.15) {
            const next = randomEdit(hostFile, rng);
            const commit = host.commitLocal(next);
            hostFile = next;
            if (commit) broadcast(JSON.parse(JSON.stringify(commit)));
          } else if (roll < 0.5) {
            const before = guest.replica.local;
            const edited = randomEdit(before, rng);
            const patch = guest.replica.propose(diffFile(before, edited));
            // What the person sees right after their edit is exactly what they made.
            expectSameShared(guest.replica.local, edited);
            if (patch) guest.outbox.push({ clientSeq: patch.clientSeq, changes: JSON.parse(JSON.stringify(patch.changes)) });
          } else if (roll < 0.75) {
            deliverToHost(guest);
          } else {
            deliverToGuest(guest);
          }
        }

        // Quiesce: deliver everything still in flight.
        while (guests.some((guest) => guest.outbox.length > 0 || guest.inbox.length > 0)) {
          for (const guest of guests) {
            deliverToHost(guest);
            deliverToGuest(guest);
          }
        }

        for (const guest of guests) {
          expect(guest.replica.pending).toHaveLength(0);
          expect(guest.replica.seq).toBe(host.seq);
          expectSameShared(guest.replica.confirmed, host.file);
          expectSameShared(guest.replica.local, host.file);
        }
        const parsed = parseDocument(JSON.parse(JSON.stringify(host.file)));
        expect(parsed.ok).toBe(true);
        expect(parsed.ok && parsed.repairs).toEqual([]);
      }),
      { seed: 20261022, numRuns: 150 },
    );
  });
});

describe('HostCore', () => {
  const base = () => addNodes(createDocument('Host'), [createNode({ id: 'n_a', type: 'service', text: 'A', x: 0, y: 0 })]);
  const rename = (text: string) => [{ kind: 'node', id: 'n_a', room: '', value: { id: 'n_a', type: 'service', text, x: 0, y: 0, width: 176, height: 68, z: 0 } }];

  it('refuses a viewer’s patch and still answers it', () => {
    const host = new HostCore(base());
    const outcome = host.receivePatch('p', { role: 'viewer', lastClientSeq: 0 }, 1, rename('B'));
    expect(outcome).toEqual({ ack: { clientSeq: 1, rejected: 'view-only' } });
    expect(host.seq).toBe(0);
  });

  it('answers a patch it already applied without applying it again', () => {
    const host = new HostCore(base());
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    expect(host.receivePatch('p', ledger, 1, rename('B')).commit?.seq).toBe(1);
    expect(host.receivePatch('p', ledger, 1, rename('C'))).toEqual({ ack: { clientSeq: 1 } });
    expect(host.file.nodes[0]!.text).toBe('B');
  });

  it('refuses what it cannot read', () => {
    const host = new HostCore(base());
    const outcome = host.receivePatch('p', { role: 'editor', lastClientSeq: 0 }, 1, [{ kind: 'node', id: 'x\u0000', room: '', value: {} }]);
    expect(outcome.ack?.rejected).toBe('malformed');
  });

  it('numbers the owner’s own commits in order', () => {
    const host = new HostCore(base());
    expect(host.commitLocal({ ...host.file, metadata: { ...host.file.metadata, title: 'One' } })).toMatchObject({ seq: 1, origin: HOST_ORIGIN });
    expect(host.commitLocal({ ...host.file, metadata: { ...host.file.metadata, title: 'Two' } })).toMatchObject({ seq: 2, origin: HOST_ORIGIN });
    expect(host.seq).toBe(2);
  });
});

describe('applyPatch', () => {
  it('is what both ends run, so a collaborator’s copy matches the owner’s commit', () => {
    const file = seededFile(rngFrom(11), 15);
    const edited = randomEdit(randomEdit(file, rngFrom(12)), rngFrom(13));
    expectSameShared(applyPatch(file, diffFile(file, edited)), edited);
  });
});
