import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { createDocument } from '../src/document/factory';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { rank } from '../src/commands/fuzzy';
import { commandsFor } from '../src/commands/registry';
import { TEXT_AUTO_MAX_HEIGHT, describeContext, describeNode, effectiveTextRole, naturalTextHeight } from '../src/nodes/describe';
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

  it('finishTextEdit removes a never-typed-into Text node left empty on abandon', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0 });
    expect(node.text).toBe('');
    // Nothing was ever typed, so this mirrors what DraftNodeView's commit()/Escape do: call with
    // the resulting (still empty) text.
    store.getState().finishTextEdit(node.id, '');
    expect(store.getState().document.nodes).toHaveLength(0);
    // Leaves no trace in history: undo must not bring back an empty, invisible node.
    expect(store.getState().history.past).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(0);
  });

  it('finishTextEdit records an undoable delete when other edits happened since the add', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0 });
    store.getState().nudgeSelection(10, 0);
    store.getState().finishTextEdit(node.id, '');
    expect(store.getState().document.nodes).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(1);
  });

  it('finishTextEdit on an empty text duplicated alongside other nodes deletes only that copy', () => {
    const text = store.getState().addNode({ type: 'text', x: 0, y: 0 });
    // Keep the empty text around (a real delete-then-undo leaves it in place, as does an import).
    store.getState().addNode({ type: 'service', x: 200, y: 0, text: 'Orders' });
    store.getState().setSelection({ nodes: store.getState().document.nodes.map((n) => n.id), edges: [] });
    store.getState().duplicateSelection();
    const copies = store.getState().document.nodes.slice(2);
    expect(copies).toHaveLength(2);
    const copiedText = copies.find((n) => n.type === 'text')!;
    expect(copiedText.id).not.toBe(text.id);

    store.getState().finishTextEdit(copiedText.id, '');
    const ids = store.getState().document.nodes.map((n) => n.id);
    expect(ids).not.toContain(copiedText.id);
    expect(ids).toContain(copies.find((n) => n.type === 'service')!.id);
  });

  it('finishTextEdit leaves a node alone once it has ever received real content', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0 });
    store.getState().updateNodeText(node.id, 'Order Service');
    // Deliberately cleared afterwards.
    store.getState().updateNodeText(node.id, '');
    expect(store.getState().document.nodes[0]!.textOrigin).toBe('explicit');
    store.getState().finishTextEdit(node.id, '');
    // Not deleted — an intentionally-cleared node is never treated as abandoned.
    expect(store.getState().document.nodes).toHaveLength(1);
    expect(store.getState().document.nodes[0]!.text).toBe('');
  });

  it('finishTextEdit is a no-op whenever the resulting text is non-empty', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0 });
    store.getState().finishTextEdit(node.id, 'API Gateway');
    expect(store.getState().document.nodes).toHaveLength(1);
  });

  it('finishTextEdit never touches a non-text node, even if somehow called for one', () => {
    const node = store.getState().addNode({ type: 'note', x: 0, y: 0 });
    store.getState().finishTextEdit(node.id, '');
    expect(store.getState().document.nodes).toHaveLength(1);
  });

  it('grows the box when a role/bold/italic change would otherwise clip the same text', () => {
    const node = store.getState().addNode({
      type: 'text',
      x: 0,
      y: 0,
      width: 120,
      height: 24,
      text: 'a fairly long piece of text that will wrap across multiple lines',
    });
    expect(store.getState().document.nodes[0]!.height).toBe(24);
    store.getState().updateNodeById(node.id, { textRole: 'title' }, 'Change text role');
    expect(store.getState().document.nodes[0]!.height).toBeGreaterThan(24);
  });

  it('never shrinks a box the user sized by hand, even after a role change', () => {
    const node = store.getState().addNode({ type: 'text', x: 0, y: 0, width: 400, height: 300, text: 'API' });
    store.getState().updateNodeById(node.id, { textRole: 'title' }, 'Change text role');
    expect(store.getState().document.nodes[0]!.height).toBe(300);
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

describe('Text — effectiveTextRole reconciles textRole and legacy annotation', () => {
  it('is body when neither is set', () => {
    expect(effectiveTextRole({})).toBe('body');
  });
  it('falls back to label when only the legacy annotation flag is set', () => {
    expect(effectiveTextRole({ annotation: true })).toBe('label');
  });
  it('an explicit textRole always wins, even over a legacy annotation flag', () => {
    expect(effectiveTextRole({ textRole: 'heading', annotation: true })).toBe('heading');
    expect(effectiveTextRole({ textRole: 'body', annotation: true })).toBe('body');
  });
});

describe('Text — semantic roles, alignment, and emphasis', () => {
  const ctx = describeContext(THEMES.light, 'clean');
  const nodeFor = (overrides: Record<string, unknown> = {}) => ({
    id: 'n',
    type: 'text' as const,
    x: 0,
    y: 0,
    z: 0,
    width: 200,
    height: 60,
    text: 'order-service',
    ...overrides,
  });

  it('each role maps to a distinct, opinionated font — never derived from raw px by the caller', () => {
    const sizeOf = (role: string) =>
      (describeNode(nodeFor({ textRole: role }), ctx).shapes[0] as { font: { size: number } }).font.size;
    expect(sizeOf('label')).toBeLessThan(sizeOf('body'));
    expect(sizeOf('body')).toBeLessThan(sizeOf('heading'));
    expect(sizeOf('heading')).toBeLessThan(sizeOf('title'));
  });

  it('technical is monospace, every other role is sans', () => {
    const stackOf = (role: string) =>
      (describeNode(nodeFor({ textRole: role }), ctx).shapes[0] as { font: { stack: string } }).font.stack;
    expect(stackOf('technical')).toBe('mono');
    for (const role of ['body', 'label', 'heading', 'title']) expect(stackOf(role)).toBe('sans');
  });

  it('bold forces the heaviest weight regardless of the role\'s own base weight', () => {
    const shape = describeNode(nodeFor({ textRole: 'body', textBold: true }), ctx).shapes[0] as {
      font: { weight: number };
    };
    expect(shape.font.weight).toBe(700);
  });

  it('italic is independent of bold and of role, and combines with both', () => {
    const shape = describeNode(nodeFor({ textRole: 'technical', textBold: true, textItalic: true }), ctx)
      .shapes[0] as { font: { weight: number; stack: string; italic?: boolean } };
    expect(shape.font.italic).toBe(true);
    expect(shape.font.weight).toBe(700);
    expect(shape.font.stack).toBe('mono');
  });

  it('a node with neither toggle set gets the exact same font object as the role default — no stray fields', () => {
    const shape = describeNode(nodeFor({ textRole: 'heading' }), ctx).shapes[0] as { font: unknown };
    expect(shape.font).toEqual(FONTS.freeTextHeading);
  });

  it('alignment maps to SVG text-anchor and an anchor x matching the box, not CSS left/center/right', () => {
    const shapeFor = (textAlign?: string) =>
      describeNode(nodeFor({ textAlign }), ctx).shapes[0] as { align: string; x: number };
    expect(shapeFor(undefined)).toMatchObject({ align: 'start', x: 0 });
    expect(shapeFor('left')).toMatchObject({ align: 'start', x: 0 });
    expect(shapeFor('center')).toMatchObject({ align: 'middle', x: 100 });
    expect(shapeFor('right')).toMatchObject({ align: 'end', x: 200 });
  });
});

describe('Text — naturalTextHeight (auto-grow)', () => {
  it('grows with more wrapped lines and never reports less than one line', () => {
    const node = { width: 120, textRole: 'body' as const };
    const ctx = describeContext(THEMES.light, 'clean');
    const one = naturalTextHeight(node, 'short', ctx);
    const many = naturalTextHeight(
      node,
      'a fairly long sentence that will wrap across several lines inside a narrow box',
      ctx,
    );
    expect(one).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(one);
  });

  it('never exceeds the auto-grow ceiling', () => {
    const node = { width: 120, textRole: 'title' as const };
    const ctx = describeContext(THEMES.light, 'clean');
    const huge = naturalTextHeight(node, Array(200).fill('line').join('\n'), ctx);
    expect(huge).toBe(TEXT_AUTO_MAX_HEIGHT);
  });
});

describe('Text — an empty node is never an invisible ghost', () => {
  const nodeFor = (overrides: Record<string, unknown> = {}) => ({
    id: 'n',
    type: 'text' as const,
    x: 0,
    y: 0,
    z: 0,
    width: 120,
    height: 32,
    text: '',
    ...overrides,
  });

  it('renders a quiet placeholder instead of nothing', () => {
    const shapes = describeNode(nodeFor(), describeContext(THEMES.light, 'clean')).shapes;
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ t: 'rect' });
  });

  it('whitespace-only text is treated the same as empty', () => {
    const shapes = describeNode(nodeFor({ text: '   \n  ' }), describeContext(THEMES.light, 'clean')).shapes;
    expect(shapes[0]).toMatchObject({ t: 'rect' });
  });

  it('the placeholder never jitters — identical across every personality preset', () => {
    const clean = describeNode(nodeFor(), describeContext(THEMES.light, 'clean'));
    const draft = describeNode(nodeFor(), describeContext(THEMES.light, 'draft'));
    const sketch = describeNode(nodeFor(), describeContext(THEMES.light, 'sketch'));
    expect(draft).toEqual(clean);
    expect(sketch).toEqual(clean);
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
