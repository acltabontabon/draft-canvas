import { describe, expect, it } from 'vitest';
import { Authorship } from '../../src/collab/authorship';
import { holdAtDoor } from '../../src/collab/door';
import { GuestSession } from '../../src/collab/guestSession';
import { HostCore } from '../../src/collab/hostCore';
import { HostSession } from '../../src/collab/hostSession';
import { fileBytes, MAX_SHARED_FILE_BYTES } from '../../src/collab/limits';
import { encode, exceedsMessageLimit, MAX_GUEST_MESSAGE_BYTES, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../../src/collab/protocol';
import { repairReferences } from '../../src/collab/repair';
import { Replica } from '../../src/collab/replica';
import { createDocument, createNode } from '../../src/document/factory';
import { createFlow } from '../../src/document/flow';
import { serializeDocument } from '../../src/export/project';
import { LIMITS } from '../../src/document/limits';
import { addNodes } from '../../src/document/operations';
import type { DraftDocument, DraftNode } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { PRODUCT } from '../../src/product';
import { tokenizeCode } from '../../src/render/code/highlight';
import { parseMarkdown } from '../../src/render/text/markdown';
import { isLookalike, nameKey } from '../../src/ui/collab/collabCopy';
import { holdingsOf, MAX_HELD_DRAWN, MAX_HELD_DRAWN_EACH, type PeerPresence } from '../../src/ui/collab/presence/model';
import { loopbackPair } from './support';

/** What one hostile collaborator could do to the owner, and to anyone else joining, within every limit. */

const time = (run: () => void) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

describe('a collaborator can’t poison the owner’s file', () => {
  it('refuses growing the shared file past what reopens, however the counts allow it', () => {
    const host = new HostCore(createDocument('Big'));
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    // Within the counts and each snippet's own limit: 18 near-200 KB snippets a patch.
    const snippet = 'x'.repeat(LIMITS.maxCodeLength - 1000);
    let refused = false;
    for (let patch = 1; patch <= 8 && !refused; patch += 1) {
      const changes = Array.from({ length: 18 }, (_, i) => {
        const id = `n_${patch}_${i}`;
        return { kind: 'node', id, room: '', value: { id, type: 'code', x: i * 300, y: patch * 300, width: 240, height: 160, z: 0, code: snippet, language: 'plaintext' } };
      });
      const outcome = host.receivePatch('p', ledger, patch, changes);
      if (outcome.ack?.rejected === 'limits') refused = true;
    }
    expect(refused).toBe(true);
    expect(fileBytes(host.file)).toBeLessThanOrEqual(MAX_SHARED_FILE_BYTES);
    // Written out the way a file is, it still opens.
    expect(parseDocument(JSON.stringify(host.file, null, 2)).ok).toBe(true);
  });
});

describe('a collaborator can’t stall the owner’s tab', () => {
  it('yields between batches of patches after the owner releases a held gesture', () => {
    let busy = true;
    let file = createDocument('Held');
    const host = new HostSession(
      { readFile: () => file, applyRemote: (next) => ((file = next), true), isBusy: () => busy, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
      { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} },
    );
    const pair = loopbackPair();
    host.attach(pair.a, { role: 'editor' });
    pair.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: file.version, name: 'Visitor' }), 'commit');
    pair.pump();
    for (let i = 1; i <= 100; i += 1) pair.b.send(encode({ t: 'patch', clientSeq: i, changes: [{ kind: 'title', value: `title${i}` }] }), 'commit');
    pair.pump();
    busy = false;
    host.drainHeld();
    expect(file.metadata.title).toBe('title32');
    for (let i = 0; i < 3; i += 1) host.drainHeld();
    expect(file.metadata.title).toBe('title100');
    host.end();
  });

  it('bounds bytes held for a collaborator’s gesture, even when the owner sends large snapshots', () => {
    let busy = false;
    let file = createDocument('Held');
    const pair = loopbackPair();
    const guest = new GuestSession(
      { readFile: () => file, applyRemote: (next) => ((file = next), true), isBusy: () => busy, open: (next) => (file = next), setAccess: () => {}, appVersion: PRODUCT.version, name: 'Visitor' },
      { status: () => {}, joined: () => {}, peers: () => {}, presence: () => {}, presenter: () => {}, rejected: () => {}, unconfirmed: () => {}, tooLarge: () => {} },
      { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} },
    );
    guest.connect(pair.b);
    pair.a.send(encode({ t: 'welcome', v: PROTOCOL_VERSION, session: 's', peer: 'p', key: 'k', role: 'editor', seq: 0, snapshot: file, peers: [] }), 'commit');
    pair.pump();
    busy = true;
    const large = JSON.stringify({ t: 'snapshot', seq: 0, snapshot: { ...file, ignored: 'x'.repeat(MAX_MESSAGE_BYTES / 8) } });
    for (let i = 0; i < 17; i += 1) {
      pair.a.send(large, 'commit');
      pair.pump();
    }
    const held = guest as unknown as { held: unknown[]; heldOut: boolean };
    expect(held.heldOut).toBe(true);
    expect(held.held).toHaveLength(0);
    busy = false;
    guest.drainHeld();
    expect(pair.sent.b.some((text) => JSON.parse(text).t === 'resync')).toBe(true);
    guest.leave();
  });

  it('bounds room resolution before following an attacker’s chain of new owners', () => {
    const host = new HostCore(createDocument('Chain'));
    const changes = Array.from({ length: 15_000 }, (_, i) => ({
      kind: 'node',
      id: `new${i}`,
      room: i === 14_999 ? '' : `new${i + 1}`,
      value: { id: `new${i}`, type: 'service', x: 0, y: 0, width: 100, height: 60, z: 0 },
    }));
    expect(exceedsMessageLimit(JSON.stringify(changes), MAX_GUEST_MESSAGE_BYTES)).toBe(false);
    // Before the depth filter, recursive resolution used to throw RangeError on this legal frame.
    expect(() => host.receivePatch('attacker', { role: 'editor', lastClientSeq: 0 }, 1, changes)).not.toThrow();
    expect(parseDocument(host.file).ok).toBe(true);
  });

  it('bounds the grouping walk: a chain of thousands is cut at the limit, the same in validation and repair', () => {
    const nodes: DraftNode[] = Array.from({ length: 3000 }, (_, i) =>
      createNode({ id: `g${i}`, type: 'group', x: 0, y: 0, ...(i > 0 ? { parentId: `g${i - 1}` } : {}) }),
    );
    const file = { ...createDocument('Chain'), nodes };
    let repaired: DraftDocument = file;
    expect(time(() => (repaired = repairReferences(file)))).toBeLessThan(500);
    const kept = repaired.nodes.filter((node) => node.parentId !== undefined).length;
    expect(kept).toBeLessThan(nodes.length - 1);
    const validated = parseDocument(file);
    expect(validated.ok).toBe(true);
    // Repair leaves a validated file as it is, so both ends of a session agree.
    if (validated.ok) expect(repairReferences(validated.document)).toBe(validated.document);
  });

  it('draws code past a length budget plain, rather than letting a grammar backtrack for seconds', () => {
    let lines: ReturnType<typeof tokenizeCode> = [];
    expect(time(() => (lines = tokenizeCode('1e'.repeat(30_000), 'typescript')))).toBeLessThan(200);
    expect(lines[0]).toEqual([{ text: '1e'.repeat(30_000), scope: null }]);
    // Ordinary code is still highlighted.
    expect(tokenizeCode('const a = 1;', 'typescript')[0]!.some((token) => token.scope !== null)).toBe(true);
  });

  it('shows text with thousands of inline markers as written, rather than parsing it for seconds', () => {
    expect(time(() => parseMarkdown('_*a'.repeat(6000)))).toBeLessThan(200);
    expect(parseMarkdown('Some **bold** text')[0]).toMatchObject({ kind: 'text' });
  });

  it('rings only so many held shapes, however large a selection someone sends', () => {
    const peer = (id: string, count: number): PeerPresence => ({
      id,
      name: id,
      color: 1,
      faint: false,
      presence: { room: '', pointer: null, selection: { nodes: Array.from({ length: count }, (_, i) => `${id}_n${i}`), edges: Array.from({ length: count }, (_, i) => `${id}_e${i}`) }, editing: null },
    });
    const one = holdingsOf([peer('a', 500)]);
    expect(one.nodes.size + one.edges.size).toBe(MAX_HELD_DRAWN_EACH);
    const many = holdingsOf(['a', 'b', 'c', 'd', 'e'].map((id) => peer(id, 500)));
    expect(many.nodes.size + many.edges.size).toBe(MAX_HELD_DRAWN);
  });
});

describe('the size cap, against contents moved out of a shape removed in the same edit', () => {
  it('still counts what was moved out, so the cap can’t be stepped round', () => {
    const host = new HostCore(createDocument('Out'));
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    let seq = 0;
    let refused = false;
    for (let round = 0; round < 120 && !refused; round += 1) {
      // A shape with a large snippet inside it…
      const owner = createNode({ id: `box_${round}`, type: 'service', text: 'Box', x: round * 10, y: 0 });
      const snippet = { id: `code_${round}`, type: 'code', x: 0, y: 0, width: 240, height: 160, z: 0, code: 'x'.repeat(190_000), language: 'plaintext' };
      host.receivePatch('p', ledger, ++seq, [{ kind: 'node', id: owner.id, room: '', value: owner }]);
      const into = host.receivePatch('p', ledger, ++seq, [{ kind: 'node', id: snippet.id, room: owner.id, value: snippet }]);
      if (into.ack?.rejected === 'limits') refused = true;
      // …then the snippet moved out and the shape removed, in one edit.
      host.receivePatch('p', ledger, ++seq, [
        { kind: 'move', target: 'node', id: snippet.id, room: '' },
        { kind: 'node', id: owner.id, room: '', value: null },
      ]);
    }
    expect(refused).toBe(true);
    expect(fileBytes(host.file)).toBeLessThanOrEqual(MAX_SHARED_FILE_BYTES);
  });
});

describe('moves', () => {
  it('refuses a patch of thousands of moves rather than spending most of a second on it', () => {
    const notes = Array.from({ length: 4000 }, (_, i) => createNode({ id: `m_${i}`, type: 'note', text: `m${i}`, x: i, y: 0 }));
    let file = addNodes(createDocument('Moves'), [createNode({ id: 'box', type: 'service', text: 'Box', x: 0, y: 0 }), ...notes]);
    const host = new HostSession({ readFile: () => file, applyRemote: (next) => ((file = next), true), isBusy: () => false, appVersion: PRODUCT.version }, { peers: () => {}, presence: () => {} }, { name: 'Owner' });
    const { a, b, pump, sent } = loopbackPair();
    host.attach(a, { role: 'editor' });
    b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: file.version, name: 'Gus' }), 'commit');
    pump();
    const welcome = JSON.parse(sent.a.find((text) => text.includes('"t":"welcome"'))!) as { epoch: number };
    const moves = notes.map((note) => ({ kind: 'move', target: 'node', id: note.id, room: 'box' }));
    let spent = 0;
    spent = time(() => {
      b.send(encode({ t: 'patch', clientSeq: 1, changes: moves, epoch: welcome.epoch }), 'commit');
      pump();
    });
    expect(spent).toBeLessThan(300);
    expect(sent.a.some((text) => text.includes('"rejected":"too-much"'))).toBe(true);
    expect(file.nodes.some((node) => node.id === 'm_0')).toBe(true);
    host.end();
  });
});

describe('the size cap’s bookkeeping, against a collaborator', () => {
  it('can’t be inflated by moving shapes in and out of a room until every edit is refused', () => {
    const notes = Array.from({ length: 300 }, (_, i) => createNode({ id: `n${i}`, type: 'note', text: `n${i}`, x: i, y: 0 }));
    const host = new HostCore(addNodes(createDocument('Churn'), [createNode({ id: 'box', type: 'service', text: 'Box', x: 0, y: 0 }), ...notes]));
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    let seq = 0;
    for (let round = 0; round < 200; round += 1) {
      const room = round % 2 === 0 ? 'box' : '';
      host.receivePatch('p', ledger, ++seq, notes.map((note) => ({ kind: 'move', target: 'node', id: note.id, room })));
    }
    expect((host as unknown as { size: number }).size).toBeLessThan(fileBytes(host.file) + 64 * 1024);
    const grow = host.receivePatch('p', ledger, ++seq, [{ kind: 'node', id: 'n_new', room: '', value: createNode({ id: 'n_new', type: 'note', text: 'Still fine', x: 0, y: 900 }) }]);
    expect(grow.commit).toBeDefined();
    // 200 rounds of 300 moves: about 2s alone, past the 5s default under the full suite's load.
  }, 30_000);
});

describe('the owner’s own file', () => {
  it('nests boundaries no deeper than every copy accepts, so owner and collaborators stay the same', () => {
    const chain = Array.from({ length: LIMITS.maxGroupDepth + 1 }, (_, i) =>
      createNode({ id: `g${i}`, type: 'group', x: 0, y: 0, ...(i > 0 ? { parentId: `g${i - 1}` } : {}) }),
    );
    let file: DraftDocument = { ...createDocument('Deep'), nodes: chain };
    const host = new HostSession({ readFile: () => file, applyRemote: (next) => ((file = next), true), isBusy: () => false, appVersion: PRODUCT.version }, { peers: () => {}, presence: () => {} }, { name: 'Owner' });
    const { a, b, pump } = loopbackPair();
    let copy: DraftDocument | null = null;
    const guest = new GuestSession(
      { readFile: () => copy!, applyRemote: (next) => ((copy = next), true), isBusy: () => false, open: (next) => (copy = next), setAccess: () => {}, appVersion: PRODUCT.version, name: 'Gus' },
      { status: () => {}, joined: () => {}, peers: () => {}, presence: () => {}, presenter: () => {}, rejected: () => {}, unconfirmed: () => {}, tooLarge: () => {} },
    );
    host.attach(a, { role: 'editor' });
    guest.connect(b);
    for (let i = 0; i < 10; i += 1) pump();
    // The owner wraps the whole chain in one more boundary: one past the limit.
    file = { ...file, nodes: [createNode({ id: 'outer', type: 'group', x: 0, y: 0 }), ...file.nodes.map((node) => (node.id === 'g0' ? { ...node, parentId: 'outer' } : node))] };
    host.commitLocal();
    for (let i = 0; i < 10; i += 1) pump();
    expect(repairReferences(file)).toBe(file);
    expect(copy!.nodes).toEqual(file.nodes);
    guest.leave();
    host.end();
  });
});

describe('the size cap’s bookkeeping', () => {
  it('counts a reorder or a move as no growth, so they are never refused near the cap', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => createNode({ id: `n${i}`, type: 'code', x: i * 10, y: 0, code: 'x'.repeat(10) }));
    const host = new HostCore({ ...createDocument('Near'), nodes });
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    // Many reorders in a row: each the same bytes as before.
    for (let seq = 1; seq <= 400; seq += 1) {
      const ids = host.file.nodes.map((node) => node.id).reverse();
      const outcome = host.receivePatch('p', ledger, seq, [{ kind: 'order', room: '', collection: 'nodes', ids }]);
      expect(outcome.ack?.rejected).toBeUndefined();
    }
    expect((host as unknown as { size: number }).size).toBe(fileBytes(host.file));
  });
});

describe('names at the door', () => {
  it('reads look-alike letters from other scripts, and look-alike Latin, as the same name', () => {
    expect(nameKey('Аlice')).toBe(nameKey('Alice'));
    expect(nameKey('AIice')).toBe(nameKey('Alice'));
    expect(nameKey('Bob')).not.toBe(nameKey('Alice'));
  });

  it('warns about two knocks with one name, not only about names already in the session', () => {
    const state = { selfName: 'Olive', peers: [], knocks: [{ id: 'g_1', name: 'Alice' }, { id: 'g_2', name: 'Аlice' }], lanKnocks: [] };
    expect(isLookalike(state, state.knocks[0]!)).toBe(true);
    expect(isLookalike({ ...state, knocks: [state.knocks[0]!] }, state.knocks[0]!)).toBe(false);
  });
});

describe('what the owner sends a collaborator', () => {
  it('never carries an embedded background image into the collaborator’s copy', () => {
    const owner = { ...createDocument('Backdrop') };
    owner.settings = { ...owner.settings, background: { ...owner.settings.background, enabled: true, image: { dataUri: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1 } } };
    const { a, b, pump } = loopbackPair();
    let copy: DraftDocument | null = null;
    const session = new GuestSession(
      { readFile: () => copy!, applyRemote: (file) => ((copy = file), true), isBusy: () => false, open: (file) => (copy = file), setAccess: () => {}, appVersion: PRODUCT.version, name: 'Gus' },
      { status: () => {}, joined: () => {}, peers: () => {}, presence: () => {}, presenter: () => {}, rejected: () => {}, unconfirmed: () => {}, tooLarge: () => {} },
    );
    session.connect(b);
    a.send(encode({ t: 'welcome', v: PROTOCOL_VERSION, session: 's_1', peer: 'p_1', key: 'k'.repeat(32), role: 'editor', seq: 0, snapshot: owner, peers: [] }), 'commit');
    pump();
    expect(copy).not.toBeNull();
    expect(copy!.settings.background.image).toBeUndefined();
    session.leave();
  });
});

describe('the local network door', () => {
  it('changes a place’s key with every welcome there, so one read off the network opens nothing later', async () => {
    let file = addNodes(createDocument('LAN'), [createNode({ type: 'service', x: 0, y: 0, text: 'A' })]);
    const host = new HostSession({ readFile: () => file, applyRemote: (next) => ((file = next), true), isBusy: () => false, appVersion: PRODUCT.version }, { peers: () => {}, presence: () => {} }, { name: 'Owner' });
    const first = loopbackPair('socket');
    host.attach(first.a, { role: 'editor' });
    first.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: file.version, name: 'Ada' }), 'commit');
    first.pump();
    const welcomed = JSON.parse(first.sent.a.find((text) => text.includes('"t":"welcome"'))!) as { peer: string; key: string };
    first.drop();

    // Back through the door, let in by the owner to the same place: a new key.
    const back = loopbackPair('socket');
    const waiting = holdAtDoor(back.a);
    back.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: file.version, name: 'Ada', resume: { peer: welcomed.peer, key: welcomed.key, seq: 0 } }), 'commit');
    back.pump();
    host.attach((await waiting)!.admit(), { role: 'editor', reuse: welcomed.peer, requireKey: true });
    await Promise.resolve();
    back.pump();
    const again = JSON.parse(back.sent.a.find((text) => text.includes('"t":"welcome"'))!) as { peer: string; key: string };
    expect(again.peer).toBe(welcomed.peer);
    expect(again.key).not.toBe(welcomed.key);
    // A place still in use is not offered as anyone's coming back.
    expect(host.waitingPlace(welcomed.peer, { exposed: true })).toBeNull();
    host.end();
  });
});

describe('the round of audit fixes', () => {
  it('keeps a file of connectors full of bends, deep in rooms, openable once written out indented', () => {
    // Three rooms down, where every line of a connector is indented furthest: eight times its compact size.
    const room = (nodes: DraftNode[]) => ({ nodes, edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } });
    const d = createNode({ id: 'n_d', type: 'service', text: 'D', x: 0, y: 0 });
    const e = createNode({ id: 'n_e', type: 'service', text: 'E', x: 600, y: 0 });
    const c = { ...createNode({ id: 'n_c', type: 'service', text: 'C', x: 0, y: 0 }), inside: room([d, e]) };
    const b = { ...createNode({ id: 'n_b', type: 'service', text: 'B', x: 0, y: 0 }), inside: room([c]) };
    const a = { ...createNode({ id: 'n_a', type: 'service', text: 'A', x: 0, y: 0 }), inside: room([b]) };
    const host = new HostCore(addNodes(createDocument('Bends'), [a]));
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    const waypoints = Array.from({ length: 32 }, (_, i) => ({ x: i * 10, y: (i % 2) * 40 }));
    let refused = false;
    for (let patch = 1; patch <= 10 && !refused; patch += 1) {
      const changes = Array.from({ length: 1000 }, (_, i) => {
        const id = `e_${patch}_${i}`;
        return { kind: 'edge', id, room: 'n_c', value: { id, source: 'n_d', target: 'n_e', waypoints } };
      });
      if (host.receivePatch('p', ledger, patch, changes).ack?.rejected === 'limits') refused = true;
    }
    expect(refused).toBe(true);
    expect(parseDocument(serializeDocument(host.file)).ok).toBe(true);
  });

  it('counts a shape moved and edited in one patch once, so moving back and forth can’t drift the count', () => {
    const note = createNode({ id: 'n_x', type: 'note', text: 'x', x: 0, y: 0 });
    const box = { ...createNode({ id: 'box', type: 'service', text: 'Box', x: 0, y: 0 }), inside: { nodes: [note], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const host = new HostCore(addNodes(createDocument('Drift'), [box, createNode({ id: 'n_keep', type: 'note', text: 'keep', x: 0, y: 300 })]));
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    const size = () => (host as unknown as { size: number }).size;
    let seq = 0;
    for (let round = 0; round < 50; round += 1) {
      const current = host.file.nodes.find((node) => node.id === 'n_x') ?? host.file.nodes.find((node) => node.id === 'box')!.inside!.nodes.find((node) => node.id === 'n_x')!;
      // Out and edited in one patch, then back in alone.
      host.receivePatch('p', ledger, ++seq, [
        { kind: 'move', target: 'node', id: 'n_x', room: '' },
        { kind: 'node', id: 'n_x', room: '', value: { ...current, text: `x${round}` } },
      ]);
      host.receivePatch('p', ledger, ++seq, [{ kind: 'move', target: 'node', id: 'n_x', room: 'box' }]);
    }
    expect(Math.abs(size() - fileBytes(host.file))).toBeLessThan(256);
  });

  it('measures the real size near the cap, so no running-count drift lets the file past it', () => {
    let clock = 0;
    const room = (nodes: DraftNode[]) => ({ nodes, edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } });
    const child = createNode({ id: 'n_child', type: 'note', text: 'c', x: 0, y: 0 });
    const inner = { ...createNode({ id: 'n_inner', type: 'service', text: 'Inner', x: 0, y: 0 }), inside: room([child]) };
    const outer = { ...createNode({ id: 'n_outer', type: 'service', text: 'Outer', x: 0, y: 0 }), inside: room([inner]) };
    // Near the cap from the start: snippets the owner already had.
    const snippets = Array.from({ length: 70 }, (_, i) => createNode({ id: `n_s${i}`, type: 'code', x: i, y: 900, code: 'y'.repeat(LIMITS.maxCodeLength - 1000) }));
    const host = new HostCore(addNodes(createDocument('Near'), [outer, ...snippets]), () => clock);
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    let seq = 0;
    for (let round = 0; round < 60; round += 1) {
      clock += 100;
      const current = indexOfChild(host.file);
      // The container out with its child edited, then back in alone: a pattern counted a little off.
      host.receivePatch('p', ledger, ++seq, [
        { kind: 'move', target: 'node', id: 'n_inner', room: '' },
        { kind: 'node', id: 'n_child', room: 'n_inner', value: { ...current, text: `c${round}` } },
      ]);
      host.receivePatch('p', ledger, ++seq, [{ kind: 'move', target: 'node', id: 'n_inner', room: 'n_outer' }]);
      // And always one more snippet tried: refused once the real file would pass the cap.
      const id = `n_more${round}`;
      host.receivePatch('p', ledger, ++seq, [{ kind: 'node', id, room: '', value: { id, type: 'code', x: 0, y: 0, width: 240, height: 160, z: 0, code: 'z'.repeat(150_000), language: 'plaintext' } }]);
    }
    expect(fileBytes(host.file)).toBeLessThanOrEqual(MAX_SHARED_FILE_BYTES);
  }, 30_000);

  it('lets the owner hold only so many versions of the file for one person’s changes', () => {
    const ledger = new Authorship();
    let file = createDocument('Churn');
    for (let i = 0; i < 300; i += 1) {
      // New things each time, some removed again: a version kept per edit, without a bound.
      const next = addNodes(file, [createNode({ id: `n_${i}`, type: 'note', text: `${i}`, x: i, y: 0 })]);
      ledger.record('gus', file, next);
      file = next;
    }
    const held = (ledger as unknown as { versions: Map<string, Map<DraftDocument, number>> }).versions.get('gus')!;
    expect(held.size).toBeLessThanOrEqual(64);
    // Taking their changes back still works for what is kept, and says the earliest are too far back —
    // not that someone else built on them, and not, a second time, that nothing is left.
    const first = ledger.revert('gus', file);
    expect(first).toMatchObject({ forgotten: true, partial: false, kept: false });
    expect(first.file.nodes.length).toBeLessThan(file.nodes.length);
    expect(ledger.revert('gus', first.file)).toMatchObject({ file: first.file, forgotten: true });
  });

  it('forgets nothing it needn’t: a shape made and deleted again leaves nothing to take back', () => {
    const ledger = new Authorship();
    const start = createDocument('Gone');
    const made = addNodes(start, [createNode({ id: 'n_x', type: 'note', text: 'x', x: 0, y: 0 })]);
    ledger.record('gus', start, made);
    ledger.record('gus', made, start);
    expect(ledger.has('gus')).toBe(false);
  });

  it('gives a place claimed on a Re-invite alone a new key, so the old one opens nothing', () => {
    let file = createDocument('Reinvite');
    const host = new HostSession({ readFile: () => file, applyRemote: (next) => ((file = next), true), isBusy: () => false, appVersion: PRODUCT.version }, { peers: () => {}, presence: () => {} }, { name: 'Owner' });
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    first.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: file.version, name: 'Pat' }), 'commit');
    first.pump();
    const pat = JSON.parse(first.sent.a.find((text) => text.includes('"t":"welcome"'))!) as { peer: string; key: string };
    first.drop();
    // Whoever opens the Re-invite first takes the place — with a key of its own.
    const rex = loopbackPair();
    host.attach(rex.a, { role: 'editor', reuse: pat.peer });
    rex.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: file.version, name: 'Rex' }), 'commit');
    rex.pump();
    const taken = JSON.parse(rex.sent.a.find((text) => text.includes('"t":"welcome"'))!) as { peer: string; key: string };
    expect(taken.peer).toBe(pat.peer);
    expect(taken.key).not.toBe(pat.key);
    expect(host.waitingPlace(pat.peer, { evenIfLive: true })?.key).toBe(taken.key);
    host.end();
  });

  it('refuses a patch whose commit every other copy would rebuild differently', () => {
    const flow = createFlow({ id: 'f_h', title: 'H' });
    const c = { ...createNode({ id: 'n_c', type: 'service', text: 'C', x: 0, y: 0 }), inside: { nodes: [createNode({ id: 'n_f', type: 'service', text: 'F', x: 0, y: 0 })], edges: [], flows: [flow], viewport: { x: 0, y: 0, zoom: 1 } } };
    const e = { ...createNode({ id: 'n_e', type: 'service', text: 'E', x: 400, y: 0 }), inside: { nodes: [createNode({ id: 'n_g', type: 'service', text: 'G', x: 0, y: 0 })], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const start = addNodes(createDocument('Diverge'), [c, e]);
    const host = new HostCore(start);
    const ledger = { role: 'editor' as const, lastClientSeq: 0 };
    // Moves C's only shape out (emptying the room, and with it the flow) and puts the flow in E.
    const outcome = host.receivePatch('p', ledger, 1, [
      { kind: 'move', target: 'node', id: 'n_f', room: '' },
      { kind: 'flow', id: 'f_h', room: 'n_e', value: flow },
    ]);
    if (outcome.commit) {
      // Accepted only if a copy applying the commit gets exactly the owner's file.
      const replica = new Replica(start, 0);
      expect(replica.receiveCommit(outcome.commit.seq, outcome.commit.changes)).toBe('applied');
      expect(replica.confirmed.nodes).toEqual(host.file.nodes);
    } else {
      expect(outcome.ack?.rejected).toBe('malformed');
      expect(host.file).toBe(start);
    }
  });
});

function indexOfChild(file: DraftDocument): DraftNode {
  const all: DraftNode[] = [];
  const walk = (nodes: DraftNode[]) => {
    for (const node of nodes) {
      all.push(node);
      if (node.inside) walk(node.inside.nodes);
    }
  };
  walk(file.nodes);
  return all.find((node) => node.id === 'n_child')!;
}
