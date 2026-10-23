import { describe, expect, it } from 'vitest';
import { holdAtDoor } from '../../src/collab/door';
import { GuestSession } from '../../src/collab/guestSession';
import { HostCore } from '../../src/collab/hostCore';
import { HostSession } from '../../src/collab/hostSession';
import { MAX_SHARED_FILE_BYTES } from '../../src/collab/limits';
import { encode, PROTOCOL_VERSION } from '../../src/collab/protocol';
import { repairReferences } from '../../src/collab/repair';
import { createDocument, createNode } from '../../src/document/factory';
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
    const bytes = new TextEncoder().encode(JSON.stringify(host.file)).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_SHARED_FILE_BYTES);
    // Written out the way a file is, it still opens.
    expect(parseDocument(JSON.stringify(host.file, null, 2)).ok).toBe(true);
  });
});

describe('a collaborator can’t stall the owner’s tab', () => {
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
