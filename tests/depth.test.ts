import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { serializeDocument } from '../src/export/project';
import { parseDocument } from '../src/document/validate';
import { embed, hasInside, totals, viewOf } from '../src/depth/tree';
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
    expect(totals(document)).toEqual({ nodes: 2, edges: 0 });
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
