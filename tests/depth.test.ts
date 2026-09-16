import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { serializeDocument } from '../src/export/project';
import { parseDocument } from '../src/document/validate';
import { embed, hasInside, resolvePath, totals, viewOf } from '../src/depth/tree';
import { looksLikeSystemOverview } from '../src/depth/level';
import { __resetInteraction, fileOf, useEditorStore, viewLevel } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import type { DraftDocument } from '../src/document/types';

/**
 * Architectural depth: looking inside a shape, drawing there, and coming back out.
 *
 * The guarantees this pins down are the ones a user would notice being broken: what you drew
 * inside is still there when you return and after a reload, a room you only visited leaves no
 * trace, undo behaves like one linear history across every room, and merely navigating is never
 * an edit (nothing to save, nothing another tab is told about).
 */
const store = useEditorStore;

/** A canvas with one Service to look inside, plus a bystander. */
function withPlatform() {
  const platform = createNode({ type: 'service', x: 0, y: 0, text: 'Lending Platform' });
  const external = createNode({ type: 'service', serviceKind: 'external', x: 400, y: 0, text: 'Core Banking' });
  store.setState({
    document: { ...createDocument('Lending'), nodes: [platform, external] },
    path: [],
    outer: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    liveViewport: null,
    revision: 0,
  });
  return { platform, external };
}

function file(): DraftDocument {
  return fileOf(store.getState());
}

function insideOf(id: string) {
  return file().nodes.find((node) => node.id === id)?.inside;
}

beforeEach(() => __resetInteraction());

describe('the tree', () => {
  it('a canvas nobody looked inside is its own root room, by identity', () => {
    const document = createDocument('Flat');
    expect(viewOf(document, [])).toBe(document);
    expect(embed(document, [], document)).toBe(document);
  });

  it('counts every room against the document limits', () => {
    const inner = createNode({ type: 'component', x: 0, y: 0 });
    const owner = { ...createNode({ type: 'service', x: 0, y: 0 }), inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const document = { ...createDocument('Nested'), nodes: [owner] };
    expect(totals(document)).toEqual({ nodes: 2, edges: 0, flows: 0 });
  });

  /**
   * Every empty room is handed the same arrays as its own graph, so one in-place write would reach
   * all of them at once. Frozen, that cannot happen however a caller behaves.
   */
  it('hands an empty room a graph nobody can write into', () => {
    const owner = createNode({ type: 'service', x: 0, y: 0 });
    const document = { ...createDocument('Empty room'), nodes: [owner] };
    const room = viewOf(document, [owner.id])!;
    expect(() => room.nodes.push(createNode({ type: 'service', x: 0, y: 0 }))).toThrow();
    expect(() => room.edges.push({} as never)).toThrow();
    expect(() => room.flows.push({} as never)).toThrow();
    expect(room.nodes).toHaveLength(0);
  });

  /**
   * Emptying a room takes it away, and nothing may outlive it. The view was cached on the way out,
   * so for the rest of the session the room still answered with its old camera and its old level
   * while the same file reopened gave a fresh empty one — the screen and the disk disagreeing.
   */
  it('forgets a room the moment its last shape is gone', () => {
    const owner = createNode({ type: 'service', x: 0, y: 0 });
    const inner = createNode({ type: 'service', x: 10, y: 10 });
    const withRoom = embed({ ...createDocument('Lending'), nodes: [owner] }, [owner.id], {
      ...createDocument('Lending'),
      nodes: [inner],
      viewport: { x: 900, y: 900, zoom: 2 },
      level: 'component',
    });
    expect(withRoom.nodes[0]!.inside?.nodes).toHaveLength(1);

    const emptied = embed(withRoom, [owner.id], {
      ...viewOf(withRoom, [owner.id])!,
      nodes: [],
    });
    expect(emptied.nodes[0]!.inside).toBeUndefined();

    const room = viewOf(emptied, [owner.id])!;
    expect(room.nodes).toHaveLength(0);
    expect(room.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(room.level).toBeUndefined();
    // And what a reload would make of the same file agrees.
    const reloaded = parseDocument(serializeDocument(emptied));
    expect(reloaded.ok && viewOf(reloaded.document, [owner.id])!.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe('looking inside', () => {
  it('keeps what was drawn there, and leaves the outer room alone', () => {
    const { platform } = withPlatform();
    const outerNodes = store.getState().document.nodes;

    expect(store.getState().enterInside(platform.id)).toBe(true);
    expect(store.getState().document.nodes).toHaveLength(0);

    store.getState().addNode({ type: 'service', x: 40, y: 40, text: 'Lending API' });
    expect(store.getState().document.nodes).toHaveLength(1);
    expect(insideOf(platform.id)?.nodes).toHaveLength(1);

    store.getState().exitTo(0);
    expect(store.getState().path).toEqual([]);
    expect(store.getState().document.nodes.map((n) => n.id)).toEqual(outerNodes.map((n) => n.id));
    expect(hasInside(store.getState().document.nodes[0]!)).toBe(true);

    store.getState().enterInside(platform.id);
    expect(store.getState().document.nodes[0]?.text).toBe('Lending API');
  });

  it('refuses shapes that have no inside to offer, and stops at the depth limit', () => {
    const { external } = withPlatform();
    const note = store.getState().addNode({ type: 'note', x: 0, y: 200 });
    expect(store.getState().enterInside(note.id)).toBe(false);
    // An External System is still a Service — looking inside someone else's system is allowed.
    expect(store.getState().enterInside(external.id)).toBe(true);

    for (let depth = 1; depth < 4; depth += 1) {
      const next = store.getState().addNode({ type: 'service', x: 0, y: 0, text: `Level ${depth}` });
      const entered = store.getState().enterInside(next.id);
      expect(entered).toBe(depth < 3);
    }
  });

  it('a room visited but never drawn in is never written down', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    // Moving the camera about inside is not content.
    store.getState().persistViewport({ x: 120, y: 80, zoom: 1.4 });
    store.getState().exitTo(0);
    expect(insideOf(platform.id)).toBeUndefined();
    expect(serializeDocument(file())).not.toContain('inside');
  });

  it('survives a save and a reload', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'database', x: 20, y: 20, text: 'Loans' });
    store.getState().exitTo(0);

    const result = parseDocument(serializeDocument(file()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reopened = result.document.nodes.find((n) => n.text === 'Lending Platform');
    expect(reopened?.inside?.nodes[0]?.text).toBe('Loans');
  });
});

describe('history across rooms', () => {
  it('undoing the first shape takes the room with it', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Lending API' });
    expect(insideOf(platform.id)).toBeDefined();

    store.getState().undo();
    expect(insideOf(platform.id)).toBeUndefined();
    expect(store.getState().document.nodes).toHaveLength(0);
    // Still standing in the room, ready to draw something else.
    expect(store.getState().path).toEqual([platform.id]);
  });

  it('undo from the outside goes to where the change was made', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Lending API' });
    store.getState().exitTo(0);
    expect(store.getState().path).toEqual([]);

    store.getState().undo();
    expect(store.getState().path).toEqual([platform.id]);
    expect(store.getState().document.nodes).toHaveLength(0);

    store.getState().redo();
    expect(store.getState().path).toEqual([platform.id]);
    expect(store.getState().document.nodes).toHaveLength(1);
  });

  it('an edit inside is one entry and does not disturb the outer room', () => {
    const { platform, external } = withPlatform();
    store.getState().enterInside(platform.id);
    const inner = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Lending API' });
    store.getState().updateNodeText(inner.id, 'Lending BFF');
    store.getState().exitTo(0);

    expect(store.getState().document.nodes.find((n) => n.id === external.id)).toBeDefined();
    store.getState().undo(); // the rename
    expect(store.getState().document.nodes[0]?.text).toBe('Lending API');
    store.getState().exitTo(0);
    store.getState().undo(); // the shape itself
    expect(insideOf(platform.id)).toBeUndefined();
  });
});

/**
 * A level is only ever what someone said — a starter, or the "View level" command. What follows
 * from it for the rooms inside is worked out on the spot, so changing the outer level moves them
 * all, and a canvas that has said nothing keeps saying nothing.
 */
describe('what a view is showing', () => {
  it('says nothing about a canvas nobody has said anything about', () => {
    const { platform } = withPlatform();
    expect(viewLevel(store.getState())).toBeUndefined();
    store.getState().enterInside(platform.id);
    expect(viewLevel(store.getState())).toBeUndefined();
  });

  it('hands the next level down to the rooms inside it', () => {
    const { platform } = withPlatform();
    store.getState().setViewLevel('context');
    expect(viewLevel(store.getState())).toBe('context');

    store.getState().enterInside(platform.id);
    // Inside a system in a system overview is what runs it.
    expect(viewLevel(store.getState())).toBe('container');
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().enterInside(service.id);
    expect(viewLevel(store.getState())).toBe('component');
    // And no deeper: there is no fourth level Draft Canvas has an opinion about.
    const part = store.getState().addNode({ type: 'component', x: 0, y: 0 });
    store.getState().enterInside(part.id);
    expect(viewLevel(store.getState())).toBe('component');
  });

  it('is only written down where it was chosen, and moves everything under it when it changes', () => {
    const { platform } = withPlatform();
    store.getState().setViewLevel('context');
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().exitTo(0);

    // The room inherited "Containers" without anything being stored on it.
    expect(insideOf(platform.id)?.level).toBeUndefined();
    store.getState().setViewLevel('container');
    store.getState().enterInside(platform.id);
    expect(viewLevel(store.getState())).toBe('component');

    // An explicit choice on the room itself outlasts the one outside.
    store.getState().setViewLevel('container');
    expect(insideOf(platform.id)?.level).toBe('container');
    store.getState().exitTo(0);
    store.getState().setViewLevel('context');
    store.getState().enterInside(platform.id);
    expect(viewLevel(store.getState())).toBe('container');
  });

  it('survives a save and a reload', () => {
    const { platform } = withPlatform();
    store.getState().setViewLevel('context');
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().setViewLevel('component');
    store.getState().exitTo(0);

    const result = parseDocument(serializeDocument(file()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.level).toBe('context');
    expect(result.document.nodes.find((n) => n.id === platform.id)?.inside?.level).toBe('component');
  });
});

describe('navigating is not an edit', () => {
  it('leaves the revision alone so nothing is saved for it', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Lending API' });
    const settled = store.getState().revision;

    store.getState().exitTo(0);
    store.getState().enterInside(platform.id);
    store.getState().exitTo(0);
    expect(store.getState().revision).toBe(settled);
  });

  it('clears what belonged to the room being left', () => {
    const { platform, external } = withPlatform();
    const store2 = store.getState();
    store2.setSelection({ nodes: [external.id], edges: [] });
    store2.enterFocus([external.id], []);
    useUiStore.setState({ openAttachmentDetail: { hostKind: 'node', hostId: external.id, attachmentId: 'a1' } });

    store.getState().enterInside(platform.id);

    expect(store.getState().selection).toEqual({ nodes: [], edges: [] });
    expect(store.getState().focus.active).toBe(false);
    expect(useUiStore.getState().openAttachmentDetail).toBeNull();
    // Presenting is a way of looking at any room, not a property of one.
    expect(store.getState().mode).toBe('edit');
  });

  it('is refused mid-gesture, so a drag can never be recorded against the wrong room', () => {
    const { platform } = withPlatform();
    store.getState().beginInteraction('Move');
    expect(store.getState().enterInside(platform.id)).toBe(false);
    store.getState().endInteraction();
    expect(store.getState().enterInside(platform.id)).toBe(true);
  });

  it('never merges two edits made in different rooms into one undo step', () => {
    const { platform, external } = withPlatform();
    store.getState().updateNodeText(platform.id, 'Lending');
    store.getState().enterInside(external.id);
    const inner = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    // Same coalesce window, same kind of edit — but a different room, so they stay apart.
    store.getState().updateNodeText(inner.id, 'Ledger');
    const depth = store.getState().history.past.length;

    store.getState().undo();
    expect(store.getState().document.nodes[0]?.text).not.toBe('Ledger');
    expect(store.getState().history.past).toHaveLength(depth - 1);
    store.getState().exitTo(0);
    expect(store.getState().document.nodes[0]?.text).toBe('Lending');
  });

  it('remembers where each room was left', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Lending API' });
    store.getState().persistViewport({ x: 30, y: 60, zoom: 1.25 });
    store.getState().exitTo(0);
    store.getState().enterInside(platform.id);
    expect(store.getState().document.viewport).toEqual({ x: 30, y: 60, zoom: 1.25 });
  });
});

/**
 * History under the sequences a real session produces, rather than one edit and one undo.
 *
 * Undo is one linear stack across every room, so the things that can go wrong are all about
 * *where* an entry belongs: an edit recorded against the wrong room, a redo branch that survives
 * an edit made somewhere else, two rooms' keystrokes merged into one step, or an undo that lands
 * you looking at a room the file no longer has.
 */
describe('history under attack', () => {
  /** Two shapes at the root, each with a room holding one shape. */
  function twoRooms() {
    const { platform, external } = withPlatform();
    store.getState().enterInside(platform.id);
    const inA = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'A1' });
    store.getState().exitTo(0);
    store.getState().enterInside(external.id);
    const inB = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'B1' });
    store.getState().exitTo(0);
    return { platform, external, inA, inB };
  }

  function textsAt(path: readonly string[]): string[] {
    const view = path.length === 0 ? file() : viewOf(file(), path)!;
    return view.nodes.map((n) => n.text ?? '');
  }

  it('walks a run of edits in three rooms backwards and forwards without losing its place', () => {
    const { platform, external } = twoRooms();

    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 100, y: 0, text: 'A2' });
    store.getState().exitTo(0);
    store.getState().enterInside(external.id);
    store.getState().addNode({ type: 'service', x: 100, y: 0, text: 'B2' });
    store.getState().exitTo(0);
    store.getState().addNode({ type: 'note', x: 0, y: 400, text: 'Root note' });

    const entries = store.getState().history.past.length;
    expect(entries).toBe(5);

    // Backwards: the root note, then B2, then A2 — each in the room it was made in.
    store.getState().undo();
    expect(textsAt([])).not.toContain('Root note');
    store.getState().undo();
    expect(store.getState().path).toEqual([external.id]);
    expect(textsAt([external.id])).toEqual(['B1']);
    store.getState().undo();
    expect(store.getState().path).toEqual([platform.id]);
    expect(textsAt([platform.id])).toEqual(['A1']);

    // Forwards again, all the way.
    store.getState().redo();
    store.getState().redo();
    store.getState().redo();
    expect(textsAt([platform.id])).toEqual(['A1', 'A2']);
    expect(textsAt([external.id])).toEqual(['B1', 'B2']);
    expect(textsAt([])).toContain('Root note');
    expect(store.getState().history.past).toHaveLength(entries);
    expect(store.getState().history.future).toHaveLength(0);
  });

  it('throws the redo branch away when the next edit is made in a different room', () => {
    const { platform, external } = twoRooms();
    store.getState().undo();
    expect(store.getState().history.future).toHaveLength(1);
    expect(store.getState().path).toEqual([external.id]);

    // A new edit somewhere else: the branch that was waiting no longer describes this file.
    store.getState().exitTo(0);
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 100, y: 0, text: 'A2' });
    expect(store.getState().history.future).toHaveLength(0);

    store.getState().redo();
    expect(textsAt([platform.id])).toEqual(['A1', 'A2']);
    expect(viewOf(file(), [external.id])?.nodes ?? []).toHaveLength(0);
  });

  it('never merges a burst of typing across a room boundary', () => {
    const { platform } = withPlatform();
    store.getState().updateNodeText(platform.id, 'Lending');
    store.getState().enterInside(platform.id);
    const inner = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    // Same kind of edit, same instant, different room: two steps, never one.
    store.getState().updateNodeText(inner.id, 'Lending');
    const past = store.getState().history.past;
    expect(past.at(-1)!.path).toEqual([platform.id]);
    expect(past.at(-2)!.path).toEqual([platform.id]);
    expect(past.at(-3)!.path).toEqual([]);
  });

  it('takes the room away and brings it back, however many times', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'First' });

    for (let round = 0; round < 3; round += 1) {
      store.getState().undo();
      expect(insideOf(platform.id)).toBeUndefined();
      expect(store.getState().document.nodes).toHaveLength(0);
      store.getState().redo();
      expect(insideOf(platform.id)!.nodes).toHaveLength(1);
    }

    store.getState().exitTo(0);
    store.getState().enterInside(platform.id);
    expect(textsAt([platform.id])).toEqual(['First']);
  });

  it('undoes a room emptied by a delete, and redoes the emptying', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Only' });
    store.getState().deleteSelection();
    expect(insideOf(platform.id)).toBeUndefined();

    store.getState().undo();
    expect(insideOf(platform.id)!.nodes).toHaveLength(1);
    store.getState().redo();
    expect(insideOf(platform.id)).toBeUndefined();
    // Still standing in the room that no longer exists — which is fine, it is empty, not missing.
    expect(store.getState().path).toEqual([platform.id]);
    expect(store.getState().document.nodes).toHaveLength(0);
  });

  it('undoes a level and an edit made under it, one step each', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    store.getState().setViewLevel('component');
    store.getState().addNode({ type: 'component', x: 100, y: 0, text: 'Controller' });
    expect(viewLevel(store.getState())).toBe('component');

    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(1);
    expect(viewLevel(store.getState())).toBe('component');
    store.getState().undo();
    expect(viewLevel(store.getState())).toBeUndefined();
    expect(store.getState().document.nodes).toHaveLength(1);
  });

  it('refuses to change rooms mid-gesture, and records the gesture where it began', () => {
    const { platform, external } = withPlatform();
    store.getState().beginInteraction('Move');
    expect(store.getState().enterInside(platform.id)).toBe(false);
    store.getState().updateNodeById(external.id, { x: 800, y: 40 }, 'Move');
    store.getState().endInteraction();

    const past = store.getState().history.past;
    expect(past).toHaveLength(1);
    expect(past[0]!.path).toEqual([]);
    expect(store.getState().path).toEqual([]);
  });

  /**
   * An invariant rather than another example: whatever the sequence, every entry has to describe a
   * room that exists in both of its own snapshots, or undo would land somewhere the file has not
   * got and the fallback would quietly move the user.
   */
  it('leaves every entry describing a room both of its snapshots still have', () => {
    const { platform, external } = twoRooms();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'component', x: 100, y: 0, text: 'A2' });
    store.getState().exitTo(0);
    store.getState().setSelection({ nodes: [external.id], edges: [] });
    store.getState().deleteSelection();
    store.getState().addNode({ type: 'note', x: 0, y: 500, text: 'After' });

    for (const entry of store.getState().history.past) {
      expect(resolvePath(entry.before, entry.path)).toEqual(entry.path);
      expect(resolvePath(entry.after, entry.path)).toEqual(entry.path);
    }
  });
});

/**
 * Paths go stale. The shape that owns the room you are standing in can be taken away by an undo,
 * by a reload from outside, or by a conflict you discarded — and none of those are errors. The
 * answer is always the same: surface at the nearest room that still exists, and never render
 * against an owner the file has not got.
 */
describe('standing in a room that stops existing', () => {
  it('surfaces to the nearest room that is left when an ancestor goes', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Loan Service' });
    store.getState().enterInside(service.id);
    store.getState().addNode({ type: 'component', x: 0, y: 0, text: 'Controller' });
    expect(store.getState().path).toEqual([platform.id, service.id]);

    // A reload from outside brings a file where the middle shape was never drawn.
    const withoutService: DraftDocument = {
      ...file(),
      nodes: file().nodes.map((n) => (n.id === platform.id ? { ...n, inside: undefined } : n)),
    };
    store.getState().setDocument(withoutService, { keepPath: true });

    expect(store.getState().path).toEqual([platform.id]);
    expect(store.getState().document.nodes).toHaveLength(0);
    expect(store.getState().selection).toEqual({ nodes: [], edges: [] });
  });

  it('goes all the way back to the canvas when the outermost owner is the one that went', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Loan Service' });

    const withoutPlatform: DraftDocument = { ...file(), nodes: file().nodes.filter((n) => n.id !== platform.id) };
    store.getState().setDocument(withoutPlatform, { keepPath: true });

    expect(store.getState().path).toEqual([]);
    expect(store.getState().outer).toBeNull();
    expect(store.getState().document).toBe(withoutPlatform);
  });

  it('follows an undo that removes the shape you are standing inside', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Loan Service' });
    store.getState().enterInside(service.id);
    store.getState().addNode({ type: 'component', x: 0, y: 0, text: 'Controller' });

    // Undo the component, then the service that owns the room it was in.
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().path).toEqual([platform.id]);
    expect(store.getState().document.nodes).toHaveLength(0);
    // And forwards again lands back where the change was made.
    store.getState().redo();
    expect(store.getState().path).toEqual([platform.id]);
    expect(store.getState().document.nodes.map((n) => n.text)).toEqual(['Loan Service']);
  });
});

/**
 * The one question Draft Canvas asks about what a canvas is showing.
 *
 * The rule it has to keep is that asking is not guessing: nothing is written, and nothing about
 * what the app suggests changes, until somebody answers. And because the question is asked in an
 * empty room — which is not a room, and has nowhere to keep an answer — the answer goes to the
 * canvas outside, which is what the question was about anyway.
 */
describe('asking whether a canvas is a system overview', () => {
  const overview = () => ({
    ...createDocument('Lending'),
    nodes: [
      createNode({ type: 'actor', x: 0, y: 0, text: 'Borrower' }),
      createNode({ type: 'service', x: 200, y: 0, text: 'Lending Platform' }),
      createNode({ type: 'service', serviceKind: 'external', x: 400, y: 0, text: 'Core Banking' }),
    ],
  });

  it('recognises people, our systems and theirs, and nothing else', () => {
    expect(looksLikeSystemOverview(overview())).toBe(true);

    // Ours but nobody else's, or theirs but none of ours: not an overview of anything.
    const onlyOurs = { ...overview(), nodes: overview().nodes.slice(1, 2) };
    expect(looksLikeSystemOverview(onlyOurs)).toBe(false);
    const onlyTheirs = { ...overview(), nodes: [overview().nodes[0]!, overview().nodes[2]!] };
    expect(looksLikeSystemOverview(onlyTheirs)).toBe(false);

    // Two shapes is a sketch, not a picture of a system among others — and the ordinary diagrams
    // people draw all day look exactly like this. Being wrong costs more than being quiet.
    const pair = { ...overview(), nodes: overview().nodes.slice(0, 2) };
    expect(looksLikeSystemOverview(pair)).toBe(false);

    // One shape that belongs to a different altitude, and the question is not asked at all.
    for (const type of ['database', 'queue', 'component', 'note'] as const) {
      const mixed = { ...overview(), nodes: [...overview().nodes, createNode({ type, x: 600, y: 0 })] };
      expect(looksLikeSystemOverview(mixed)).toBe(false);
    }
    expect(looksLikeSystemOverview(createDocument('Blank'))).toBe(false);
  });

  it('writes the answer where the question was about, in one step', () => {
    const doc = overview();
    const platform = doc.nodes[1]!;
    store.setState({
      document: doc,
      path: [],
      outer: null,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      liveViewport: null,
      revision: 0,
    });
    store.getState().enterInside(platform.id);
    expect(viewLevel(store.getState())).toBeUndefined();

    store.getState().setOuterViewLevel(store.getState().path.length - 1, 'context');

    // The canvas outside says it; this room derives Containers from that and stores nothing.
    expect(file().level).toBe('context');
    expect(viewLevel(store.getState())).toBe('container');
    expect(insideOf(platform.id)).toBeUndefined();
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().history.past[0]!.path).toEqual([]);

    // And one undo takes it back, standing where the change was made.
    store.getState().undo();
    expect(file().level).toBeUndefined();
    expect(store.getState().path).toEqual([]);
  });

  it('refuses to reach further out than the canvas', () => {
    const { platform } = withPlatform();
    store.getState().enterInside(platform.id);
    store.getState().setOuterViewLevel(-1, 'context');
    store.getState().setOuterViewLevel(5, 'context');
    expect(store.getState().history.past).toHaveLength(0);
    expect(file().level).toBeUndefined();
  });
});
