import { beforeEach, describe, expect, it } from 'vitest';
import { arrangeView } from '../src/agent/arrange';
import { compose, fillOf, fitsClearlyBetter } from '../src/agent/compile';
import { Problems } from '../src/agent/errors';
import { arrangedSize, measureContext } from '../src/agent/place';
import { checkQuality } from '../src/agent/quality';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { deserializeDocument } from '../src/export/project';
import { layoutGraph } from '../src/layout/layered';
import { nameLineCount, naturalArchitectureSize } from '../src/nodes/describe';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { directionNote } from '../src/ui/Editor/arrangeSummary';

/**
 * Arrange's proportions: long names get boxes they read in, gaps are as long as what crosses them
 * needs, captions keep off boundary headers, and the reading direction weighs how the diagram fits a
 * screen — all shown as a preview, with the direction to choose, before anything moves.
 */

const LONG_NAME = 'Customer-Facing Public API Gateway and Edge Routing Layer for Web and Mobile';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_proportion0').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

/** A long name typed into a default-width box: the canvas grows it taller, line by line. */
function typedNarrow(node: DraftNode, text: string): DraftNode {
  const named = { ...node, text, width: 176, height: 68 };
  const size = naturalArchitectureSize(named, measureContext(), { maxWidth: 176, maxHeight: 800, maxNameLines: Number.POSITIVE_INFINITY });
  return { ...named, height: size.height };
}

/** A gateway fanning out to three boundaries, reading down — the case that read worst before. */
function capabilities(): DraftDocument {
  const doc = build({
    layout: { direction: 'down' },
    groups: [
      { id: 'orders', label: 'Order capabilities' },
      { id: 'billing', label: 'Billing capabilities' },
      { id: 'catalog', label: 'Catalog capabilities' },
    ],
    nodes: [
      { id: 'customer', type: 'actor', label: 'Customer' },
      { id: 'gateway', type: 'gateway', label: 'Gateway' },
      { id: 'o1', type: 'service', label: 'Order Placement', group: 'orders' },
      { id: 'b1', type: 'service', label: 'Invoicing', group: 'billing' },
      { id: 'c1', type: 'service', label: 'Product Search', group: 'catalog' },
    ],
    relationships: [
      { id: 'cg', from: 'customer', to: 'gateway', label: 'Uses' },
      { id: 'g1', from: 'gateway', to: 'o1', label: 'Routes orders' },
      { id: 'g2', from: 'gateway', to: 'b1', label: 'Routes billing' },
      { id: 'g3', from: 'gateway', to: 'c1', label: 'Routes search' },
    ],
  });
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === 'gateway' ? typedNarrow(n, LONG_NAME) : n)) };
}

function arrange(doc: DraftDocument, direction: 'right' | 'down' = 'down') {
  return arrangeView(doc, { connectors: 'tidy', move: true, bothDirections: true, layout: { direction, spacing: 'comfortable', allowDegraded: false, normalizePeerSizes: false } as never }, measureContext(), new Problems(), '/arrange')!;
}

describe('long names', () => {
  it('gives a long name typed into a narrow box a wider, shorter one when the view is arranged', () => {
    const ctx = measureContext();
    const narrow = typedNarrow(createNode({ id: 'g', type: 'service', x: 0, y: 0 }), LONG_NAME);
    expect(nameLineCount(narrow, ctx)).toBeGreaterThan(3);
    const size = arrangedSize(narrow, ctx);
    expect(size.width).toBeGreaterThan(narrow.width);
    expect(size.height).toBeLessThan(narrow.height);
    expect(nameLineCount({ ...narrow, ...size }, ctx)).toBeLessThanOrEqual(3);
    expect(naturalArchitectureSize({ ...narrow, ...size }, ctx, { maxWidth: size.width, maxHeight: size.height, maxNameLines: 3 }).fits).toBe(true);
  });

  it('keeps a box that is tall for another reason, and a short name’s box as it was', () => {
    const ctx = measureContext();
    const tall = { ...createNode({ id: 't', type: 'service', x: 0, y: 0, text: 'Orders' }), height: 200 };
    expect(arrangedSize(tall, ctx)).toEqual({ width: tall.width, height: 200 });
  });

  it('composes a name too long for two lines at the usual width instead of refusing it', () => {
    const doc = build({ nodes: [{ id: 'g', type: 'gateway', label: LONG_NAME }] });
    const gateway = doc.nodes.find((n) => n.id === 'g')!;
    expect(gateway.width).toBeGreaterThan(280);
    expect(nameLineCount(gateway, measureContext())).toBeLessThanOrEqual(3);
  });
});

describe('gaps and captions', () => {
  const spacing = { layer: 104, tight: 72, sibling: 54, pad: 36, component: 108 };
  const boxes = [{ id: 'a', width: 176, height: 68 }, { id: 'b', width: 176, height: 68 }];
  const gapOf = (labelHeight: number) => {
    const out = layoutGraph({ boxes, groups: [], edges: [{ id: 'e', source: 'a', target: 'b', labelWidth: 60, labelHeight }], direction: 'down', spacing });
    return out.boxes.get('b')!.y - (out.boxes.get('a')!.y + 68);
  };

  it('keeps a gap only as long as what crosses it needs', () => {
    // A plain connector, and one whose short caption sits beside it reading down: the tight gap.
    expect(gapOf(0)).toBe(72);
    expect(gapOf(16)).toBe(72);
    // A caption taller than that gets its own room with air.
    expect(gapOf(48)).toBeGreaterThan(72);
  });

  it('lays a gateway fanning out to boundaries with its captions out of their headers', () => {
    const arranged = arrange(capabilities());
    expect(checkQuality(arranged.view.nodes, arranged.view.edges, measureContext()).errors).toEqual([]);
    const gateway = arranged.view.nodes.find((n) => n.id === 'gateway')!;
    expect(nameLineCount(gateway, measureContext())).toBeLessThanOrEqual(2);
  });

  it('reports a caption in a boundary’s header row', () => {
    const group = createNode({ id: 'g', type: 'group', x: 0, y: 200, width: 400, height: 240, text: 'Catalog capabilities' });
    const a = createNode({ id: 'a', type: 'service', x: 112, y: 100, text: 'A' });
    const b = { ...createNode({ id: 'b', type: 'service', x: 112, y: 280, text: 'B' }), parentId: 'g' };
    // Pinned bottom to top, its caption at its middle: on the boundary's header row.
    const edge = { ...createEdge({ id: 'e', source: 'a', target: 'b', label: 'Routes search', routing: 'straight' }), sourceAnchor: { side: 'bottom' as const, offset: 0.5 }, targetAnchor: { side: 'top' as const, offset: 0.5 } };
    const doc = addEdges(addNodes(createDocument('Header'), [group, a, b]), [edge]);
    const errors = checkQuality(doc.nodes, doc.edges, measureContext()).errors;
    const header = errors.find((issue) => issue.ids.includes('g') && issue.kind === 'label-over-node');
    expect(header?.message).toContain('header');
  });
});

describe('reading direction and proportion', () => {
  const read = (width: number, height: number, crossings = 0, cost = 100) => ({ width, height, crossings, cost });

  it('measures how much of a screen a diagram fills', () => {
    expect(fillOf(1440, 900)).toBeCloseTo(1);
    expect(fillOf(720, 900)).toBeCloseTo(0.5);
    expect(fillOf(1600, 1000, [800, 1000])).toBeCloseTo(0.5);
  });

  it('turns a big, tall diagram that would fill the screen read the other way', () => {
    expect(fitsClearlyBetter(read(1600, 800), read(700, 1400))).toBe(true);
  });

  it('never turns for proportion alone when the turn crosses more, reads worse, or is small anyway', () => {
    expect(fitsClearlyBetter(read(1600, 800, 1), read(700, 1400, 0))).toBe(false);
    expect(fitsClearlyBetter(read(1600, 800, 0, 200), read(700, 1400, 0, 100))).toBe(false);
    // Two shapes read across fill little of a screen, but fit it at full size either way.
    expect(fitsClearlyBetter(read(176, 208), read(424, 68))).toBe(false);
    // A long chain is a strip either way: down fills more, but not enough to be worth the turn.
    expect(fitsClearlyBetter(read(176, 1100), read(1400, 68))).toBe(false);
  });

  it('hands back the other direction too, for a person to choose', () => {
    const arranged = arrange(capabilities());
    expect(arranged.direction).toBe('down');
    expect(arranged.alternative?.direction).toBe('right');
    expect(arranged.alternative!.view.nodes.map((n) => n.id).sort()).toEqual(arranged.view.nodes.map((n) => n.id).sort());
  });
});

describe('Arrange in the editor', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: capabilities(),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
      mode: 'edit',
      selectedFlowId: null,
      path: [],
      outer: null,
    });
    useUiStore.setState({ tidyPreview: null, arrangePreview: null, readOnly: null, flowTrace: null });
  });

  it('plans both directions without changing anything, then applies the chosen one as one undo step', async () => {
    const before = useEditorStore.getState().document;
    const plan = await useEditorStore.getState().planArrange();
    if (!plan || typeof plan === 'string') throw new Error(`no preview: ${String(plan)}`);
    expect(Object.keys(plan.options).sort()).toEqual(['down', 'right']);
    expect(plan).toMatchObject({ direction: 'down', suggested: 'down', current: 'down', scoped: false });
    expect(useEditorStore.getState().document).toBe(before);
    expect(useEditorStore.getState().history.past).toHaveLength(0);

    expect(useEditorStore.getState().commitArrange({ ...plan, direction: 'right' })).toBe(true);
    const after = useEditorStore.getState();
    expect(after.document.nodes).toEqual(plan.options.right!.nodes);
    expect(after.history.past.at(-1)!.label).toBe('Arrange');
    after.undo();
    expect(useEditorStore.getState().document.nodes).toEqual(before.nodes);
  });

  it('says so when the room is already arranged, and refuses a preview of a room changed since', async () => {
    const plan = await useEditorStore.getState().planArrange();
    if (!plan || typeof plan === 'string') throw new Error('no preview');
    useEditorStore.getState().commitArrange(plan);
    expect(await useEditorStore.getState().planArrange()).toBe('unchanged');

    const next = await useEditorStore.getState().planArrange();
    expect(next).toBe('unchanged');
    useEditorStore.getState().undo();
    const fresh = await useEditorStore.getState().planArrange();
    if (!fresh || typeof fresh === 'string') throw new Error('no preview');
    useEditorStore.getState().addNode({ type: 'service', x: 2000, y: 0, text: 'Late' });
    expect(useEditorStore.getState().commitArrange(fresh)).toBe(false);
  });

  it('arranges only the selection when asked, in the view’s own direction', async () => {
    useEditorStore.getState().setSelection({ nodes: ['o1', 'b1'], edges: [] });
    const plan = await useEditorStore.getState().planArrange(true);
    if (plan && typeof plan !== 'string') {
      expect(plan.scoped).toBe(true);
      expect(Object.keys(plan.options)).toEqual(['down']);
    } else expect(['unchanged', 'no-room']).toContain(plan);
  });

  it('keeps one cleanup preview at a time', () => {
    const doc = useEditorStore.getState().document;
    useUiStore.getState().setArrangePreview({ path: [], base: doc, options: { down: doc }, direction: 'down', suggested: 'down', current: 'down', scoped: false });
    useUiStore.getState().setTidyPreview({ path: [], base: doc, view: doc, moved: 0, reattached: 0, scoped: false });
    expect(useUiStore.getState().arrangePreview).toBeNull();
  });

  it('names the direction shown', () => {
    expect(directionNote({ direction: 'down', suggested: 'down', current: 'down' })).toBe('Suggested');
    expect(directionNote({ direction: 'down', suggested: 'right', current: 'down' })).toBe('As it reads now');
    expect(directionNote({ direction: 'right', suggested: 'down', current: 'down' })).toBe('Turned');
  });
});
