import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { createDocument } from '../src/document/factory';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { rank } from '../src/commands/fuzzy';
import { commandsFor } from '../src/commands/registry';
import { describeContext, describeNode } from '../src/nodes/describe';
import { FONTS } from '../src/render/text/fonts';
import { THEMES } from '../src/render/theme/tokens';
import { stubContext } from './commandStubs';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * Label/Text: "visual annotation with no architectural behaviour" — Draft Canvas's existing
 * `type: 'text'` node ("Label with no box", already in the palette) already had all the generic
 * node machinery this needs. What was missing was ever *pinning* the one thing that matters most
 * now that Draft Canvas is adding opinionated primitives next to it: a Label must never
 * participate in the capability matrix as a real endpoint, no matter what it's connected to —
 * otherwise a future "architecture validation"/"quick actions" pass would have to guess whether a
 * `text` node touching an edge means something or is just a caption someone dragged near a line.
 */

describe('Label/Text — no architectural semantics', () => {
  it('categoryOf reads it as generic, same as every other plain-annotation shape', () => {
    for (const type of ['text', 'note', 'code', 'group'] as const) {
      expect(categoryOf({ type })).toBe('generic');
    }
  });

  it('has no capability-matrix opinion connected to anything — including the new Component', () => {
    for (const other of ['service', 'component', 'database', 'queue', 'actor', 'external'] as const) {
      expect(capabilityFor('generic', other)).toBeUndefined();
      expect(capabilityFor(other, 'generic')).toBeUndefined();
    }
    expect(capabilityFor('generic', 'generic')).toBeUndefined();
  });
});

describe('Label/Text — creation, editing, and generic node machinery', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Label'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('creates with no box-implying default — an empty label, sized as a caption', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0 });
    expect(node.text).toBe('');
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
  });

  it('is editable, movable, resizable, deletable, and all of it is one undo step apiece', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0, text: 'Driving Adapters' });
    expect(store.getState().history.past).toHaveLength(1);

    store.getState().updateNodeText(node.id, 'Driven Adapters');
    expect(store.getState().document.nodes[0]!.text).toBe('Driven Adapters');

    store.getState().commitPositions(new Map([[node.id, { x: 200, y: 200 }]]));
    expect(store.getState().document.nodes[0]!.x).toBe(200);

    store.getState().updateNodeById(node.id, { width: 240, height: 30 });
    expect(store.getState().document.nodes[0]!.width).toBe(240);

    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().deleteSelection();
    expect(store.getState().document.nodes).toHaveLength(0);

    store.getState().undo(); // delete
    store.getState().undo(); // resize
    store.getState().undo(); // move
    store.getState().undo(); // edit
    store.getState().undo(); // the original add
    expect(store.getState().document.nodes).toHaveLength(0);
    store.getState().redo(); // add
    store.getState().redo(); // edit
    expect(store.getState().document.nodes[0]!.text).toBe('Driven Adapters');
  });

  it('duplicates and copy/pastes with zero Label-specific code, like Component', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0, text: 'Application Core' });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().duplicateSelection();
    expect(store.getState().document.nodes).toHaveLength(2);
    expect(store.getState().document.nodes[1]!.text).toBe('Application Core');
  });

  it('round-trips through the file format unchanged', () => {
    store.getState().addNode({ type: 'text', x: 10, y: 20, text: 'Zone A' });
    const result = deserializeDocument(serializeDocument(store.getState().document));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    expect(result.document.nodes[0]!).toMatchObject({ type: 'text', text: 'Zone A' });
  });
});

describe('Label/Text — distinct from an edge label', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Label'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('a floating annotation and a real relationship caption are different things entirely', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    // The edge's own relationship — a real, semantically meaningful caption.
    expect(edge.semantic).toBe('writes');

    // A Label placed nearby is not part of the graph at all: it has no source/target, isn't in
    // `document.edges`, and connecting *to* it would just make it an ordinary (semantics-free,
    // per the block above) node — the edge and the annotation never merge into one concept.
    const label = store.getState().addNode({ type: 'text', x: 150, y: -60, text: 'writes' });
    expect(store.getState().document.edges.map((e) => e.id)).toEqual([edge.id]);
    expect(label.type).toBe('text');
  });
});

// A later revision needed a Label quiet enough to sit near a boundary crossing without competing
// with real node labels — reusing exactly the tokens a connector's own inferred caption already
// uses, rather than inventing a third size/colour.
describe('Label/Text — the "annotation" rendering variant', () => {
  const ctx = describeContext(THEMES.light, 'clean');
  const nodeFor = (annotation?: boolean) => ({
    id: 'n',
    type: 'text' as const,
    x: 0,
    y: 0,
    z: 0,
    width: 120,
    height: 24,
    text: 'Inbound ports',
    annotation,
  });

  it('is unset by default and leaves an ordinary Label rendered exactly as before', () => {
    const plain = describeNode(nodeFor(undefined), ctx);
    const explicitlyFalse = describeNode(nodeFor(false), ctx);
    expect(plain).toEqual(explicitlyFalse);
  });

  it('renders smaller and in a different colour than a plain Label when set', () => {
    const plain = describeNode(nodeFor(false), ctx).shapes[0] as { font: { size: number }; fill: string };
    const annotation = describeNode(nodeFor(true), ctx).shapes[0] as { font: { size: number }; fill: string };
    expect(annotation.font.size).toBeLessThan(plain.font.size);
    expect(annotation.fill).not.toBe(plain.fill);
  });

  it('reuses the exact same quiet caption tokens a connector\'s own inferred relationship uses', () => {
    const shape = describeNode(nodeFor(true), ctx).shapes[0] as { font: { size: number }; fill: string };
    expect(shape.font).toEqual(FONTS.connectorCaption);
    expect(shape.fill).toBe(THEMES.light.textFaint);
  });
});

describe('Label/Text — reachable from the command palette as "label"/"heading"', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Label'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('answers to label/caption/heading, and still leads for a bare "text" query', () => {
    for (const query of ['label', 'caption', 'heading', 'text']) {
      const top = rank(query, commandsFor(stubContext()))[0]!;
      expect(top.entry.id).toBe('add-text');
    }
  });
});
