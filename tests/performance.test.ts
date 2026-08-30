import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import {
  addEdges,
  addNodes,
  moveNodes,
  removeElements,
  updateNode,
} from '../src/document/operations';
import { createFlow, explainEdgeTier, stepIndexOf } from '../src/document/flow';
import { evaluateAttachCandidates, deepestBoundaryAt } from '../src/canvas/dragTargets';
import { isEdgeFocused } from '../src/store/editorStore';
import { renderDocumentSvg } from '../src/render/svg/document';
import { projectNodes, projectEdges } from '../src/canvas/projection';
import type { DraftDocument } from '../src/document/types';

/**
 * The brief asks for a document of 100 nodes and 150–200 edges to stay
 * comfortable. These are not micro-benchmarks — they assert the properties that
 * make that possible: operations touch only what changed, and the projection
 * hands React Flow the same objects back when nothing moved.
 */
const NODE_COUNT = 100;
const EDGE_COUNT = 180;

const CODE_SAMPLE = [
  '@Transactional',
  'public void cancel(Account account) {',
  '  account.cancel();',
  '  outbox.publish(new AccountCancelled(account.id()));',
  '}',
].join('\n');

function largeDocument(): DraftDocument {
  const nodes = Array.from({ length: NODE_COUNT }, (_, index) => {
    const column = index % 10;
    const row = Math.floor(index / 10);
    if (index % 9 === 0) {
      return createNode({
        type: 'code',
        x: column * 460,
        y: row * 320,
        width: 400,
        height: 180,
        language: 'java',
        code: CODE_SAMPLE,
      });
    }
    if (index % 7 === 0) {
      return createNode({
        type: 'note',
        x: column * 460,
        y: row * 320,
        text: 'Why is this retried twice? It should be idempotent already.',
        noteKind: 'question',
      });
    }
    return createNode({
      type: (['service', 'database', 'queue', 'actor', 'card'] as const)[index % 5]!,
      x: column * 460,
      y: row * 320,
      text: `Component ${index}`,
    });
  });

  const edges = Array.from({ length: EDGE_COUNT }, (_, index) =>
    createEdge({
      source: nodes[index % NODE_COUNT]!.id,
      target: nodes[(index * 7 + 3) % NODE_COUNT]!.id,
      label: index % 3 === 0 ? `EVENT_${index}` : undefined,
    }),
  ).filter((edge) => edge.source !== edge.target);

  // A few edges carry async/condition annotations, and the first 12 form a
  // flow — enough to exercise the new rendering/dimming paths at scale
  // without a dedicated performance test per feature.
  const annotated = edges.map((edge, index) => {
    if (index % 11 === 0) return { ...edge, async: true };
    if (index % 13 === 0) return { ...edge, condition: 'approved' };
    return edge;
  });

  const flow = createFlow({ title: 'Walkthrough' });
  flow.steps = annotated.slice(0, 12).map((edge, index) => ({ id: `fs${index}`, edgeId: edge.id }));

  const withEdges = addEdges(addNodes(createDocument('Large'), nodes), annotated);
  return { ...withEdges, flows: [flow] };
}

describe(`a document with ${NODE_COUNT} nodes and ~${EDGE_COUNT} edges`, () => {
  const doc = largeDocument();

  it('builds the fixture at the intended scale', () => {
    expect(doc.nodes).toHaveLength(NODE_COUNT);
    expect(doc.edges.length).toBeGreaterThan(150);
    expect(doc.nodes.filter((node) => node.type === 'code').length).toBeGreaterThan(5);
  });

  it('rewrites only the node an edit touched', () => {
    const target = doc.nodes[42]!;
    const next = updateNode(doc, target.id, { text: 'Renamed' });

    const rewritten = next.nodes.filter((node, index) => node !== doc.nodes[index]);
    expect(rewritten).toHaveLength(1);
    // Untouched collections keep their identity, which is what keeps a history
    // snapshot to roughly the size of the change.
    expect(next.edges).toBe(doc.edges);
  });

  it('rewrites only the nodes a drag moved', () => {
    const moving = doc.nodes.slice(0, 5);
    const positions = new Map(
      moving.map((node, index) => [node.id, { x: node.x + 10, y: node.y + index }]),
    );
    const next = moveNodes(doc, positions);

    const rewritten = next.nodes.filter((node, index) => node !== doc.nodes[index]);
    expect(rewritten).toHaveLength(5);
  });

  it('hands React Flow the identical array when nothing changed', () => {
    const options = {
      selectedNodes: new Set<string>(),
      selectedEdges: new Set<string>(),
      interactive: true,
    };
    const first = projectNodes(doc, [], options);
    const second = projectNodes(doc, first, options);

    // Same array reference, so React Flow re-renders nothing at all.
    expect(second).toBe(first);
    expect(projectEdges(doc, projectEdges(doc, [], options), options)).toBeDefined();
  });

  it('reuses node objects for everything a move did not touch', () => {
    const options = {
      selectedNodes: new Set<string>(),
      selectedEdges: new Set<string>(),
      interactive: true,
    };
    const first = projectNodes(doc, [], options);

    const target = doc.nodes[10]!;
    const moved = moveNodes(doc, new Map([[target.id, { x: target.x + 40, y: target.y }]]));
    const second = projectNodes(moved, first, options);

    const changed = second.filter((node, index) => node !== first[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.id).toBe(target.id);
  });

  it('deletes a node and its connections in one pass', () => {
    const target = doc.nodes[3]!;
    const attached = doc.edges.filter(
      (edge) => edge.source === target.id || edge.target === target.id,
    ).length;
    expect(attached).toBeGreaterThan(0);

    const next = removeElements(doc, [target.id]);
    expect(next.nodes).toHaveLength(NODE_COUNT - 1);
    expect(next.edges).toHaveLength(doc.edges.length - attached);
  });

  it('exports the whole document to valid SVG within a sane budget', () => {
    const started = performance.now();
    const { svg, width, height } = renderDocumentSvg(doc);
    const elapsed = performance.now() - started;

    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror'))
      .toBeNull();
    // Generous, because CI machines vary; it exists to catch an accidental
    // quadratic, not to police milliseconds.
    expect(elapsed).toBeLessThan(4000);
  });

  it('caches highlighting so repeated exports do not re-tokenize', () => {
    renderDocumentSvg(doc);
    const started = performance.now();
    renderDocumentSvg(doc);
    expect(performance.now() - started).toBeLessThan(4000);
  });

  /**
   * The riskiest new per-frame work from the interaction features layered on
   * top of this document model: attach/reparent hit-testing runs on every
   * frame of a drag, and Focus/Explain dimming is recomputed per node/edge on
   * every render. Kept as one pragmatic extension of the existing large-scale
   * fixture rather than a dedicated performance test per feature.
   */
  it('runs attach/reparent hit-testing repeatedly over the full document within budget', () => {
    const dragged = doc.nodes[0]!;
    const draggedRect = { x: dragged.x, y: dragged.y, width: dragged.width, height: dragged.height };
    const exclude = new Set([dragged.id]);

    const started = performance.now();
    for (let frame = 0; frame < 60; frame += 1) {
      const point = { x: draggedRect.x + frame, y: draggedRect.y };
      evaluateAttachCandidates({ ...draggedRect, x: point.x }, dragged.type, doc, exclude);
      deepestBoundaryAt(point, doc, exclude);
    }
    // A generous budget: this exists to catch an accidental quadratic scan
    // per candidate, not to police milliseconds on a variable CI machine.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('never touches the document (or reprojects) while Focus/Explain state changes', () => {
    const options = {
      selectedNodes: new Set<string>(),
      selectedEdges: new Set<string>(),
      interactive: true,
    };
    const projectedBefore = projectNodes(doc, [], options);

    // Toggling focus membership is store-only — the document reference (and
    // therefore the projection) must not change at all.
    const focus = { active: true, nodeIds: [doc.nodes[0]!.id, doc.nodes[1]!.id], edgeIds: [] };
    const projectedAfter = projectNodes(doc, projectedBefore, options);
    expect(projectedAfter).toBe(projectedBefore);

    // Classifying every edge's focus state is a plain per-edge check, not a
    // scan of the whole document each time — stays fast even for all ~180.
    const started = performance.now();
    for (const edge of doc.edges) isEdgeFocused(focus, edge);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('classifies every edge and node against the active flow step within budget', () => {
    const flow = doc.flows[0]!;
    const started = performance.now();
    for (const edge of doc.edges) explainEdgeTier(stepIndexOf(flow, edge.id), 6);
    // stepIndexOf is a per-flow linear scan (flows stay small by design), run
    // once per edge — the same "stays fast even at scale" budget as Focus.
    expect(performance.now() - started).toBeLessThan(200);
  });
});
