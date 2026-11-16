import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { createFlow } from '../../src/document/flow';
import { LIMITS } from '../../src/document/limits';
import { parseDocument } from '../../src/document/validate';
import { diffFile } from '../../src/collab/diff';
import { HostCore, idsUnique } from '../../src/collab/hostCore';
import { applyChanges } from '../../src/collab/apply';
import { encode, MAX_MESSAGE_BYTES, parseWire, readGuestMessage, readHostMessage } from '../../src/collab/protocol';
import { sanitizeChanges } from '../../src/collab/sanitize';
import { randomEdit, rngFrom, seededFile } from './support';

/** Values shaped like changes, with every field liable to be wrong. */
const anyId = fc.oneof(fc.constant(''), fc.constant('n_1'), fc.constant('e_1'), fc.string({ maxLength: 8 }), fc.string({ minLength: 129, maxLength: 140 }), fc.integer());
const changeLike = fc.record(
  {
    kind: fc.constantFrom('node', 'edge', 'flow', 'point', 'move', 'title', 'settings', 'level', 'order', 'bogus'),
    id: anyId,
    room: fc.oneof(fc.constant(''), anyId),
    target: fc.constantFrom('node', 'edge', 'flow', 'x'),
    collection: fc.constantFrom('nodes', 'edges', 'flows', 'points', 'x'),
    ids: fc.array(anyId, { maxLength: 5 }),
    value: fc.oneof(fc.constant(null), fc.anything({ maxDepth: 3 }), fc.record({ id: anyId, type: fc.string(), source: anyId, target: anyId, steps: fc.anything(), targets: fc.anything(), kind: fc.string() })),
  },
  { requiredKeys: ['kind'] },
);

describe('sanitizeChanges', () => {
  it('never throws, and whatever it accepts leaves the owner’s file valid', () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(changeLike, { maxLength: 12 }), (seed, raw) => {
        const host = new HostCore(seededFile(rngFrom(seed), 10));
        const outcome = host.receivePatch('p', { role: 'editor', lastClientSeq: 0 }, 1, raw);
        expect(outcome.commit !== undefined || outcome.ack !== undefined).toBe(true);
        const parsed = parseDocument(JSON.parse(JSON.stringify(host.file)));
        expect(parsed.ok).toBe(true);
        expect(parsed.ok && parsed.repairs).toEqual([]);
      }),
      { seed: 1022, numRuns: 400 },
    );
  });

  it('accepts what an honest copy sends, unchanged', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = rngFrom(seed);
        const file = seededFile(rng, 10);
        const changes = diffFile(file, randomEdit(randomEdit(file, rng), rng));
        const result = sanitizeChanges(JSON.parse(JSON.stringify(changes)));
        expect(result.ok).toBe(true);
        expect(result.ok && result.changes).toEqual(JSON.parse(JSON.stringify(changes)));
      }),
      { seed: 33, numRuns: 200 },
    );
  });

  it('keeps every spotlight reference in a flow covering the maximum number of shapes', () => {
    const nodes = Array.from({ length: LIMITS.maxNodes }, (_, i) => createNode({ id: `n_${i}`, type: 'service', x: i, y: 0 }));
    const flow = createFlow({ title: 'Whole system' });
    for (let i = 0; i < nodes.length; i += LIMITS.maxExtraMembersPerStep) {
      flow.steps.push({ id: `step_${i}`, extraNodeIds: nodes.slice(i, i + LIMITS.maxExtraMembersPerStep).map((node) => node.id) });
    }
    const file = { ...createDocument('Full'), nodes, flows: [flow] };
    const parsed = parseDocument(file);
    expect(parsed.ok && parsed.repairs).toEqual([]);

    const changes = [{ kind: 'flow', id: flow.id, room: '', value: flow }];
    const result = sanitizeChanges(changes);
    expect(result.ok).toBe(true);
    expect(result.ok && result.changes).toEqual(changes);
  });

  it('keeps a compensating action linked to the connector it undoes', () => {
    const a = createNode({ id: 'n_a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'n_b', type: 'service', x: 300, y: 0 });
    const charge = createEdge({ id: 'e_charge', source: a.id, target: b.id, semantic: 'calls' });
    const refund = createEdge({ id: 'e_refund', source: a.id, target: b.id, semantic: 'compensates', compensationFor: charge.id, compensationVisible: false });
    const file = { ...createDocument('Saga'), nodes: [a, b], edges: [charge, refund] };
    const parsed = parseDocument(file);
    expect(parsed.ok && parsed.repairs).toEqual([]);

    // Before, the one-edge validation dropped the link, so a guest renaming the action unlinked it in the owner's file.
    const changes = [{ kind: 'edge', id: refund.id, room: '', value: { ...refund, label: 'Refund' } }];
    const result = sanitizeChanges(changes);
    expect(result.ok && result.changes).toEqual(changes);
    const host = new HostCore(file);
    host.receivePatch('p', { role: 'editor', lastClientSeq: 0 }, 1, changes);
    expect(host.file.edges.find((edge) => edge.id === refund.id)).toMatchObject({ label: 'Refund', compensationFor: charge.id, compensationVisible: false });

    // A link on a connector that is not a compensation is still not kept.
    const plain = sanitizeChanges([{ kind: 'edge', id: 'e_x', room: '', value: { id: 'e_x', source: a.id, target: b.id, compensationFor: charge.id } }]);
    expect(plain.ok && (plain.changes[0] as { value: object }).value).not.toHaveProperty('compensationFor');
  });

  it('refuses ids validation would have to rename', () => {
    expect(sanitizeChanges([{ kind: 'node', id: 'bad\u0001id', room: '', value: { id: 'bad\u0001id', type: 'service' } }]).ok).toBe(false);
    expect(sanitizeChanges([{ kind: 'edge', id: 'e', room: '', value: { id: 'e', source: 'a', target: 'a' } }]).ok).toBe(false);
    expect(sanitizeChanges([{ kind: 'node', id: 'a', room: '', value: { id: 'b', type: 'service' } }]).ok).toBe(false);
  });

  it('never lets a node value smuggle in a room', () => {
    const result = sanitizeChanges([
      { kind: 'node', id: 'a', room: '', value: { id: 'a', type: 'service', inside: { nodes: [{ id: 'x', type: 'service' }], edges: [], flows: [] } } },
    ]);
    expect(result.ok && result.changes[0]).toMatchObject({ kind: 'node', id: 'a' });
    expect(result.ok && 'inside' in (result.changes[0] as { value: object }).value).toBe(false);
  });

  it('cuts text to the same limits a file is held to', () => {
    const raw = `  ${'x'.repeat(5000)}  `;
    const result = sanitizeChanges([{ kind: 'title', value: raw }]);
    const fromFile = parseDocument({ ...createDocument(), metadata: { ...createDocument().metadata, title: raw } });
    expect(result.ok && result.changes[0]).toEqual({ kind: 'title', value: fromFile.ok && fromFile.document.metadata.title });
    expect(result.ok && (result.changes[0] as { value: string }).value.length).toBeLessThanOrEqual(200);
  });
});

describe('the wire', () => {
  it('refuses keys that only exist to reach an object’s prototype', () => {
    expect(parseWire('{"t":"ping","n":1,"__proto__":{"polluted":true}}')).toBeNull();
    expect(parseWire('{"t":"patch","clientSeq":1,"changes":[{"constructor":{}}]}')).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses what is too large before parsing it', () => {
    expect(parseWire(' '.repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
  });

  it('reads only well-formed messages', () => {
    expect(readGuestMessage(parseWire(encode({ t: 'ping', n: 3 })))).toEqual({ t: 'ping', n: 3 });
    expect(readGuestMessage({ t: 'patch', clientSeq: 0, changes: [] })).toBeNull();
    expect(readGuestMessage({ t: 'hello', v: 1, app: '2.0.0', doc: 21, name: '‮evil\u0000' })).toEqual({ t: 'hello', v: 1, app: '2.0.0', doc: 21, name: 'evil' });
    expect(readGuestMessage({ t: 'hello', v: 1, app: '2.0.0', doc: 21, name: '   ' })).toBeNull();
    expect(readHostMessage({ t: 'commit', seq: 0, changes: [], origin: 'host' })).toBeNull();
    expect(readHostMessage({ t: 'end', reason: 'nonsense' })).toBeNull();
    expect(readHostMessage({ t: 'presence', peer: 'p', presence: { room: '', pointer: { x: Infinity, y: 0 }, selection: { nodes: [], edges: [] }, editing: null } })).toBeNull();
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        readGuestMessage(value);
        readHostMessage(value);
      }),
      { seed: 5, numRuns: 500 },
    );
  });
});

/**
 * The diff and apply cover every root field of a document by name. A field added to `DraftDocument`
 * without being shared (or deliberately left out, as cameras and bookkeeping are) would silently
 * stop reaching collaborators — so adding one fails here until someone decides which it is.
 */
it('accounts for every field of a document', () => {
  const shared = ['metadata', 'nodes', 'edges', 'flows', 'ink', 'settings', 'openPoints', 'level'];
  const notShared = ['format', 'version', 'viewport'];
  const keys = Object.keys({ ...createDocument(), level: 'context', ink: [] }).sort();
  expect(keys).toEqual([...shared, ...notShared].sort());
});

describe('one id, one element', () => {
  const owner = () => {
    const service = { id: 'n_s', type: 'service', x: 0, y: 0, width: 176, height: 68, z: 0 };
    return { ...createDocument('Ids'), nodes: [service] } as ReturnType<typeof createDocument>;
  };
  const node = { id: 'X', type: 'service', x: 10, y: 10, width: 100, height: 60, z: 1 };

  it('refuses a patch that names the same element twice', () => {
    expect(sanitizeChanges([{ kind: 'node', id: 'X', room: '', value: node }, { kind: 'node', id: 'X', room: 'n_s', value: node }]).ok).toBe(false);
  });

  it('adds an id new to the file in one room only, even when applying unchecked changes', () => {
    const applied = applyChanges(owner(), [
      { kind: 'node', id: 'X', room: '', value: node as never },
      { kind: 'node', id: 'X', room: 'n_s', value: node as never },
    ]);
    expect(idsUnique(applied)).toBe(true);
  });
});
