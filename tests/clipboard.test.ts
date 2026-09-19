import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeClipboard, encodeClipboard } from '../src/document/clipboardCodec';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, extractFragment } from '../src/document/operations';
import { LIMITS } from '../src/document/limits';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import type { DraftNode, ViewLevel } from '../src/document/types';

const store = useEditorStore;

function reset() {
  __resetInteraction();
  __resetClipboardSync();
  store.setState({
    document: createDocument('Clipboard'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    pasteRepeat: 0,
    revision: 0,
    path: [],
    outer: null,
  });
}

describe('clipboard codec', () => {
  it('preserves a manual routing override across copy and paste', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0 });
    const edge = createEdge({ source: a.id, target: b.id, routeMode: 'direct' });
    // A fragment round-trips through `normalizeDocument`, so a field missing
    // from that normalizer is stripped here and nowhere else — the quiet way
    // to lose a user's choice.
    const decoded = decodeClipboard(encodeClipboard({ nodes: [a, b], edges: [edge] }));
    expect(decoded!.edges[0]!.routeMode).toBe('direct');
  });

  it('round-trips nodes and edges', () => {
    const a = createNode({ type: 'note', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'note', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: a.id, target: b.id });
    const text = encodeClipboard({ nodes: [a, b], edges: [edge] });

    const decoded = decodeClipboard(text)!;
    expect(decoded.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(decoded.edges).toHaveLength(1);
    expect(decoded.edges[0]!.source).toBe(a.id);
  });

  it('rejects anything that is not a Draft Canvas payload', () => {
    expect(decodeClipboard('')).toBeNull();
    expect(decodeClipboard('not json at all')).toBeNull();
    expect(decodeClipboard(JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(decodeClipboard(JSON.stringify({ format: 'something-else', nodes: [], edges: [] }))).toBeNull();
  });
});

describe('cross-diagram paste', () => {
  beforeEach(reset);

  it('pastes a fragment encoded from one document into a different, unrelated one', () => {
    const sourceNode = createNode({ type: 'note', x: 0, y: 0, text: 'From elsewhere' });
    const sourceDoc = addNodes(createDocument('Source'), [sourceNode]);
    const fragment = extractFragment(sourceDoc, [sourceNode.id]);
    const roundTripped = decodeClipboard(encodeClipboard(fragment))!;

    // The open document is a completely different one from the source.
    store.setState({ clipboard: roundTripped });
    store.getState().paste({ x: 0, y: 0 });

    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]!.text).toBe('From elsewhere');
    expect(doc.nodes[0]!.id).not.toBe(sourceNode.id);
    // The source document this fragment came from is untouched.
    expect(sourceDoc.nodes).toHaveLength(1);
    expect(sourceDoc.nodes[0]!.id).toBe(sourceNode.id);
  });
});

describe('duplicate preserves attachments but regenerates their ids', () => {
  beforeEach(reset);

  it('gives a duplicated node a fresh attachment id', () => {
    const node = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    store.getState().attachToNode(node.id, {
      id: 'a_original',
      type: 'note',
      text: 'careful here',
    });
    const originalAttachmentId = store.getState().document.nodes[0]!.attachments![0]!.id;

    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().duplicateSelection();

    const copy = store.getState().document.nodes.find((n) => n.id !== node.id)!;
    expect(copy.attachments).toHaveLength(1);
    expect(copy.attachments![0]!.id).not.toBe(originalAttachmentId);
    expect(copy.attachments![0]!.text).toBe('careful here');
  });
});

describe('group/boundary copy', () => {
  beforeEach(reset);

  function boundaryWithChild() {
    const boundary = createNode({ type: 'group', x: 0, y: 0, width: 200, height: 200 });
    const child = createNode({ type: 'note', x: 10, y: 10, text: 'Child', parentId: boundary.id });
    const doc = addNodes(createDocument(), [boundary, child]);
    return { doc, boundary, child };
  }

  it('remaps a child to the pasted copy of its parent when both are selected', () => {
    const { doc, boundary, child } = boundaryWithChild();
    store.setState({ document: doc });
    store.getState().setSelection({ nodes: [boundary.id, child.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 500, y: 500 });

    const pastedIds = store.getState().selection.nodes;
    const pastedBoundary = store.getState().document.nodes.find(
      (n) => pastedIds.includes(n.id) && n.type === 'group',
    )!;
    const pastedChild = store.getState().document.nodes.find(
      (n) => pastedIds.includes(n.id) && n.type !== 'group',
    )!;
    expect(pastedChild.parentId).toBe(pastedBoundary.id);
    expect(pastedChild.parentId).not.toBe(boundary.id);
  });

  it('drops the parent link when only the child is selected', () => {
    const { doc, child } = boundaryWithChild();
    store.setState({ document: doc });
    store.getState().setSelection({ nodes: [child.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 500, y: 500 });

    const pastedIds = store.getState().selection.nodes;
    const pastedChild = store.getState().document.nodes.find((n) => pastedIds.includes(n.id))!;
    expect(pastedChild.parentId).toBeUndefined();
  });

  it('keeps the boundary when a copied child is pasted back inside it through the paste event', () => {
    const { doc, boundary, child } = boundaryWithChild();
    store.setState({ document: doc });
    store.getState().setSelection({ nodes: [child.id], edges: [] });
    const text = store.getState().copySelection()!;
    // The browser's own paste event hands the app back the very text it just wrote.
    expect(store.getState().applyExternalClipboardText(text)).toBe(true);
    store.getState().paste({ x: 100, y: 100 });

    const pastedId = store.getState().selection.nodes[0]!;
    expect(store.getState().document.nodes.find((n) => n.id === pastedId)!.parentId).toBe(boundary.id);
  });

  it('copying just the boundary brings its contents, and leaves the originals alone', () => {
    const { doc, boundary, child } = boundaryWithChild();
    store.setState({ document: doc });
    store.getState().setSelection({ nodes: [boundary.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 500, y: 500 });

    const original = store.getState().document.nodes.find((n) => n.id === child.id)!;
    expect(original.parentId).toBe(boundary.id);
    // A boundary is its contents — cutting one deletes them, so a copy must carry them too.
    const pasted = store.getState().document.nodes.filter((n) => store.getState().selection.nodes.includes(n.id));
    expect(pasted).toHaveLength(2);
    const pastedBoundary = pasted.find((n) => n.type === 'group')!;
    expect(pasted.find((n) => n.type !== 'group')!.parentId).toBe(pastedBoundary.id);
  });
});

// Regression coverage: `LIMITS.maxNodes`/`maxEdges` was previously only enforced on a document
// taken as a whole (file import, clipboard decode) — nothing stopped a paste or duplicate merged
// into an already-large *open* document from growing past those caps.
describe('paste/duplicate respects the document size limits', () => {
  beforeEach(() => {
    reset();
    useUiStore.setState({ toasts: [] });
  });

  it('caps a paste at LIMITS.maxNodes and notifies once', () => {
    const existing = Array.from({ length: LIMITS.maxNodes - 2 }, (_, i) =>
      createNode({ type: 'note', x: i, y: 0, text: `N${i}` }),
    );
    store.setState({ document: addNodes(createDocument(), existing) });
    const fragment = {
      nodes: [
        createNode({ type: 'note', x: 0, y: 0, text: 'A' }),
        createNode({ type: 'note', x: 10, y: 0, text: 'B' }),
        createNode({ type: 'note', x: 20, y: 0, text: 'C' }),
      ],
      edges: [],
    };
    store.setState({ clipboard: fragment });

    store.getState().paste({ x: 0, y: 0 });

    expect(store.getState().document.nodes).toHaveLength(LIMITS.maxNodes);
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });

  it('grouping at the node cap is refused rather than adding a boundary a reload would drop', () => {
    const existing = Array.from({ length: LIMITS.maxNodes }, (_, i) =>
      createNode({ type: 'note', x: i * 200, y: 0, text: `N${i}` }),
    );
    store.setState({ document: addNodes(createDocument(), existing) });
    store.getState().setSelection({ nodes: [existing[0]!.id, existing[1]!.id], edges: [] });

    store.getState().groupSelection();

    expect(store.getState().document.nodes).toHaveLength(LIMITS.maxNodes);
    expect(store.getState().document.nodes.some((n) => n.type === 'group')).toBe(false);
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });

  it('caps duplicateSelection the same way', () => {
    const existing = Array.from({ length: LIMITS.maxNodes - 1 }, (_, i) =>
      createNode({ type: 'note', x: i, y: 0, text: `N${i}` }),
    );
    const doc = addNodes(createDocument(), existing);
    store.setState({ document: doc });
    store.getState().setSelection({ nodes: [existing[0]!.id, existing[1]!.id], edges: [] });

    store.getState().duplicateSelection();

    expect(store.getState().document.nodes).toHaveLength(LIMITS.maxNodes);
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });

  it('does not notify when a paste stays comfortably under the cap', () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'Solo' });
    store.setState({ clipboard: { nodes: [node], edges: [] } });

    store.getState().paste({ x: 0, y: 0 });

    expect(store.getState().document.nodes).toHaveLength(1);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});

describe('applyExternalClipboardText', () => {
  beforeEach(reset);

  it('adopts valid Draft Canvas text and resets the paste stagger', () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'From a paste event' });
    const text = encodeClipboard({ nodes: [node], edges: [] });
    store.setState({ pasteRepeat: 3 });

    const applied = store.getState().applyExternalClipboardText(text);

    expect(applied).toBe(true);
    expect(store.getState().clipboard?.nodes[0]?.text).toBe('From a paste event');
    expect(store.getState().pasteRepeat).toBe(0);
  });

  it('returns false and leaves the clipboard untouched for foreign text', () => {
    const applied = store.getState().applyExternalClipboardText('just some text');

    expect(applied).toBe(false);
    expect(store.getState().clipboard).toBeNull();
  });

  it('returns true on an unchanged repeat without resetting the stagger', () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'Once' });
    const text = encodeClipboard({ nodes: [node], edges: [] });

    store.getState().applyExternalClipboardText(text);
    store.setState({ pasteRepeat: 7 });
    const applied = store.getState().applyExternalClipboardText(text);

    expect(applied).toBe(true);
    expect(store.getState().pasteRepeat).toBe(7);
  });
});

describe('syncClipboardFromSystem', () => {
  beforeEach(() => {
    reset();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { readText: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adopts valid system-clipboard content and resets the paste stagger', async () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'From the OS' });
    const text = encodeClipboard({ nodes: [node], edges: [] });
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValue(text);
    store.setState({ pasteRepeat: 3 });

    await expect(store.getState().syncClipboardFromSystem()).resolves.toBe(true);

    expect(store.getState().clipboard?.nodes[0]?.text).toBe('From the OS');
    expect(store.getState().pasteRepeat).toBe(0);
  });

  it('ignores non-Draft-Canvas clipboard content, but still reports the read as successful', async () => {
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValue('just some text');

    // The permission read itself worked — `false` is reserved for denied/unavailable/rejected,
    // not for "the clipboard happened to hold something else."
    await expect(store.getState().syncClipboardFromSystem()).resolves.toBe(true);

    expect(store.getState().clipboard).toBeNull();
  });

  it('does not re-apply identical text on a second call', async () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'Once' });
    const text = encodeClipboard({ nodes: [node], edges: [] });
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockResolvedValue(text);

    await store.getState().syncClipboardFromSystem();
    store.setState({ pasteRepeat: 7 });
    await store.getState().syncClipboardFromSystem();

    // Same text as before — the second call is a no-op, so the stagger it
    // would otherwise reset is left untouched.
    expect(store.getState().pasteRepeat).toBe(7);
  });

  it('never throws when readText rejects, and resolves false', async () => {
    (navigator.clipboard.readText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    await expect(store.getState().syncClipboardFromSystem()).resolves.toBe(false);
  });
});

// Exercises internal-edge preservation and external-edge exclusion through
// the store's own copy/paste, complementing the pure-operations coverage in
// `document.test.ts`.
describe('self-contained subgraph copy', () => {
  beforeEach(reset);

  it('copying B and C out of A→B→C carries only B→C', () => {
    const a = createNode({ type: 'note', x: 0, y: 0, text: 'A' });
    const b = createNode({ type: 'note', x: 200, y: 0, text: 'B' });
    const c = createNode({ type: 'note', x: 400, y: 0, text: 'C' });
    const ab = createEdge({ source: a.id, target: b.id });
    const bc = createEdge({ source: b.id, target: c.id });
    const doc = addEdges(addNodes(createDocument(), [a, b, c]), [ab, bc]);
    store.setState({ document: doc });

    store.getState().setSelection({ nodes: [b.id, c.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 1000, y: 1000 });

    const pastedIds = new Set(store.getState().selection.nodes);
    const pastedEdges = store.getState().document.edges.filter((e) => store.getState().selection.edges.includes(e.id));
    expect(pastedEdges).toHaveLength(1);
    expect(pastedIds.has(pastedEdges[0]!.source)).toBe(true);
    expect(pastedIds.has(pastedEdges[0]!.target)).toBe(true);
    // Nothing pasted references the un-copied node A — the original A→B
    // edge is untouched, but no *pasted* edge dangles off of it.
    expect(pastedEdges.some((e) => e.source === a.id || e.target === a.id)).toBe(false);
    expect(store.getState().document.edges).toHaveLength(3); // original A→B, B→C, plus pasted B'→C'
  });
});

/**
 * Copying a shape copies what is inside it, and a copy has to be a genuinely separate thing — two
 * shapes sharing the ids of the nodes in their rooms would make every id-keyed thing in the app
 * (selection, routing, flows, an open card) ambiguous the first time someone went inside either.
 */
describe('copying a shape with an inside', () => {
  beforeEach(reset);

  function platformWithRoom(level?: ViewLevel): DraftNode {
    const inner = createNode({ type: 'component', x: 10, y: 10, text: 'Controller' });
    const store2 = createNode({ type: 'database', x: 200, y: 10, text: 'Loans' });
    const link = createEdge({ source: inner.id, target: store2.id });
    return {
      ...createNode({ type: 'service', x: 0, y: 0, text: 'Lending Platform' }),
      inside: {
        nodes: [inner, store2],
        edges: [link],
        flows: [{ id: 'f_1', title: 'Apply', steps: [{ id: 'fs_1', edgeId: link.id }] }],
        viewport: { x: 0, y: 0, zoom: 1 },
        ...(level ? { level } : {}),
      },
    };
  }

  function innerIdsOf(index: number) {
    const node = store.getState().document.nodes[index]!;
    return {
      nodes: node.inside!.nodes.map((n) => n.id),
      edges: node.inside!.edges.map((e) => e.id),
      steps: node.inside!.flows[0]!.steps.map((s) => s.edgeId),
    };
  }

  it('gives every duplicate its own ids, all the way down', () => {
    const platform = platformWithRoom();
    store.setState({ document: addNodes(createDocument('Lending'), [platform]) });

    store.getState().setSelection({ nodes: [platform.id], edges: [] });
    store.getState().duplicateSelection();
    store.getState().setSelection({ nodes: [platform.id], edges: [] });
    store.getState().duplicateSelection();

    const copies = [innerIdsOf(0), innerIdsOf(1), innerIdsOf(2)];
    const everyNodeId = copies.flatMap((c) => c.nodes);
    expect(new Set(everyNodeId).size).toBe(everyNodeId.length);
    const everyEdgeId = copies.flatMap((c) => c.edges);
    expect(new Set(everyEdgeId).size).toBe(everyEdgeId.length);

    // A flow in the copied room still narrates that room's own connector.
    for (const copy of copies) expect(copy.steps).toEqual(copy.edges);
  });

  it('carries the inside through the system clipboard into another canvas', () => {
    const platform = platformWithRoom();
    const fragment = extractFragment(addNodes(createDocument('Lending'), [platform]), [platform.id]);
    const decoded = decodeClipboard(encodeClipboard(fragment));
    expect(decoded?.nodes[0]?.inside?.nodes).toHaveLength(2);
    expect(decoded?.nodes[0]?.inside?.edges).toHaveLength(1);
  });

  it('counts what a shape brings with it against the canvas limits', () => {
    const crowd = Array.from({ length: LIMITS.maxNodes - 3 }, (_, i) =>
      createNode({ type: 'note', x: i, y: 0 }),
    );
    const platform = platformWithRoom();
    store.setState({ document: addNodes(createDocument('Full'), [...crowd, platform]) });

    store.getState().setSelection({ nodes: [platform.id], edges: [] });
    store.getState().duplicateSelection();
    // The file already holds maxNodes - 2 + 1 inside room = the copy's three would overflow it.
    expect(store.getState().document.nodes).toHaveLength(LIMITS.maxNodes - 2);
  });

  it('refuses to nest a pasted shape deeper than a canvas keeps', () => {
    // A → B → C, then B (which holds C) pasted into B's own room: C's copy would sit four deep.
    const c = platformWithRoom();
    const b = { ...createNode({ type: 'service', x: 0, y: 0, text: 'B' }), inside: { nodes: [c], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const a = { ...createNode({ type: 'service', x: 0, y: 0, text: 'A' }), inside: { nodes: [b], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    store.setState({ document: addNodes(createDocument('Deep'), [a]) });
    store.getState().enterInside(a.id);
    store.getState().setSelection({ nodes: [b.id], edges: [] });
    store.getState().copySelection();
    store.getState().enterInside(b.id);
    const before = store.getState().document.nodes.length;
    store.getState().paste();
    expect(store.getState().document.nodes).toHaveLength(before);
    expect(useUiStore.getState().toasts.at(-1)?.message).toMatch(/deeper than a canvas goes/);
  });

  it('counts the flows a shape brings with it against the canvas limit', () => {
    const platform = platformWithRoom();
    const flows = Array.from({ length: LIMITS.maxFlows - 2 }, (_, i) => ({ id: `f_top_${i}`, title: `F${i}`, steps: [] }));
    store.setState({ document: { ...addNodes(createDocument('Flows'), [platform]), flows } });
    store.getState().setSelection({ nodes: [platform.id], edges: [] });
    store.getState().duplicateSelection();
    store.getState().duplicateSelection();
    // One more flow fits; the second copy's would be one too many.
    expect(store.getState().document.nodes).toHaveLength(2);
  });

  /**
   * What a room says it shows travels with it. Ids are the only thing a copy may change, and the
   * level is not one — a copy that lost it started deriving one from wherever it was pasted, and a
   * room deliberately marked as just a drawing quietly stopped being one.
   */
  it.each(['component', 'none'] as const)('keeps a room\'s own "%s" level through a duplicate', (level) => {
    const platform = platformWithRoom(level);
    store.setState({ document: addNodes(createDocument('Lending'), [platform]) });

    store.getState().setSelection({ nodes: [platform.id], edges: [] });
    store.getState().duplicateSelection();

    const copy = store.getState().document.nodes[1]!;
    expect(copy.id).not.toBe(platform.id);
    expect(copy.inside!.level).toBe(level);
  });

  it('keeps a room\'s level through the system clipboard', () => {
    const platform = platformWithRoom('none');
    const fragment = extractFragment(addNodes(createDocument('Lending'), [platform]), [platform.id]);
    expect(decodeClipboard(encodeClipboard(fragment))?.nodes[0]?.inside?.level).toBe('none');
  });
});
