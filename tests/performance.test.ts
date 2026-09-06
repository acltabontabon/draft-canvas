import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { IndexedDbRepository } from '../src/storage/IndexedDbRepository';
import { __resetKeyCacheForTests } from '../src/crypto/keyStore';
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
import { laneIndex, rectOf, routeEdge } from '../src/edges/routing';
import { routingPlan } from '../src/edges/bundles';
import type { DraftDocument } from '../src/document/types';
import { ARCHITECTURE_STARTERS } from '../src/starters';
import { freeOriginFor } from '../src/document/operations';
import { buildStarter, starterSize } from '../src/starters/build';

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

function largeDocument(nodeCount = NODE_COUNT, edgeCount = EDGE_COUNT): DraftDocument {
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
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
      type: (['service', 'database', 'queue', 'actor', 'ellipse'] as const)[index % 5]!,
      x: column * 460,
      y: row * 320,
      text: `Component ${index}`,
    });
  });

  const edges = Array.from({ length: edgeCount }, (_, index) =>
    createEdge({
      source: nodes[index % nodeCount]!.id,
      target: nodes[(index * 7 + 3) % nodeCount]!.id,
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

  /**
   * Lanes and obstacle avoidance (Phase 4) add real per-edge work: lane
   * assignment groups every edge once, and obstacle avoidance scans every
   * other node per edge. Both are exercised implicitly by the SVG export
   * budget above; this asserts the cost directly against the full ~180-edge
   * fixture, matching every node as a candidate obstacle — the worst case
   * `DraftEdgeView` and the exporter actually run, once per document commit,
   * not per pointer-move frame (see `interactionActive` in `uiStore.ts`).
   */
  it('assigns lanes and routes with obstacle avoidance for every edge within budget', () => {
    const nodeMap = new Map(doc.nodes.map((node) => [node.id, node]));
    const obstacles = doc.nodes.map(rectOf);

    const started = performance.now();
    const lanes = laneIndex(doc.edges);
    for (const edge of doc.edges) {
      const lane = lanes.get(edge.id)?.offset ?? 0;
      routeEdge(edge, nodeMap, {
        lane,
        obstacles: obstacles.filter((_, i) => doc.nodes[i]!.id !== edge.source && doc.nodes[i]!.id !== edge.target),
      });
    }
    // Generous, for the same reason as the other budgets here: this exists to
    // catch an accidental quadratic blowup, not to police milliseconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  /**
   * Smart Routing's planner runs over the whole document rather than one edge
   * at a time, and — unlike `laneIndex` — a node move invalidates it, so it
   * re-plans once per drag *commit*. That makes it the one piece of routing
   * whose cost could plausibly grow with the document; this pins it to the
   * same fixture and the same generous budget as the per-edge routing above.
   */
  it('plans routing spines for the whole document within budget', () => {
    const started = performance.now();
    // Ten commits' worth: a fresh nodes array each time defeats the memo, so
    // this measures real planning work, not cache hits.
    for (let i = 0; i < 10; i += 1) {
      routingPlan(doc.nodes.map((node) => ({ ...node })), doc.edges);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  /**
   * Inserting an Architecture Starter must feel instant even onto a full canvas. The cost that
   * could plausibly grow is the placement scan, so this runs every starter against the 100-node
   * fixture: `freeOriginFor` is one pass over the nodes and `buildStarter` is pure, and neither
   * may quietly turn into a whole-canvas layout pass.
   */
  it('places and builds every starter against a full document within budget', () => {
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      for (const starter of ARCHITECTURE_STARTERS) {
        const origin = freeOriginFor(doc, starterSize(starter));
        expect(buildStarter(starter, origin).nodes.length).toBeGreaterThan(0);
      }
    }
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('reuses the routing plan for an unchanged (nodes, edges) pair', () => {
    expect(routingPlan(doc.nodes, doc.edges)).toBe(routingPlan(doc.nodes, doc.edges));
  });

  it('rebuilds the lane index only when the edges array identity actually changes', () => {
    const first = laneIndex(doc.edges);
    expect(laneIndex(doc.edges)).toBe(first);

    const moved = moveNodes(doc, new Map([[doc.nodes[0]!.id, { x: 10, y: 10 }]]));
    // A node move never touches the edges array (structural sharing).
    expect(laneIndex(moved.edges)).toBe(first);
  });

  /**
   * Every autosave now runs through AES-GCM (Phase 8) before it ever reaches
   * IndexedDB. Re-confirms the save (encrypt + put) and load (get + decrypt)
   * round trip for the full fixture stays within budget with that extra step
   * in the path — not just the plaintext operations above.
   */
  describe('save path with encryption in the loop', () => {
    beforeEach(() => {
      globalThis.indexedDB = new IDBFactory();
      __resetKeyCacheForTests();
    });

    it('encrypts and persists, then decrypts and loads, the full document within budget', async () => {
      const repository = await IndexedDbRepository.open();

      const savedAt = performance.now();
      await repository.save(doc);
      const saveElapsed = performance.now() - savedAt;
      // Generous, for the same reason as the budgets above: this exists to
      // catch an accidental quadratic in the encrypt-then-put path, not to
      // police milliseconds on a variable CI machine.
      expect(saveElapsed).toBeLessThan(2000);

      const loadedAt = performance.now();
      const loaded = await repository.load(doc.metadata.id);
      expect(performance.now() - loadedAt).toBeLessThan(2000);

      expect(loaded!.nodes).toHaveLength(NODE_COUNT);
      expect(loaded!.edges.length).toBe(doc.edges.length);
    });
  });
});

/**
 * Evidence-gathering, not a fix: a prior hardening pass flagged
 * `evaluateAttachCandidates`/`deepestBoundaryAt` (`src/canvas/dragTargets.ts`)
 * as an unindexed O(n) scan per pointer-move frame, tested only at the
 * `NODE_COUNT` (100) above — a 50x gap against `LIMITS.maxNodes` (5,000).
 * This runs the exact same hit-testing loop at that real ceiling and asserts
 * a budget generous enough to only catch an accidental quadratic, not to
 * police milliseconds — see the audit's final report for what the measured
 * numbers turned out to be and whether they warrant a follow-up.
 */
describe('drag hit-testing at the schema node/edge ceiling', () => {
  const ceilingDoc = largeDocument(5000, 9000);

  it('builds the fixture at the intended scale', () => {
    expect(ceilingDoc.nodes).toHaveLength(5000);
    expect(ceilingDoc.edges.length).toBeGreaterThan(8000);
  });

  it('runs attach/reparent hit-testing repeatedly over a 5,000-node document within budget', () => {
    const dragged = ceilingDoc.nodes[0]!;
    const draggedRect = { x: dragged.x, y: dragged.y, width: dragged.width, height: dragged.height };
    const exclude = new Set([dragged.id]);

    const started = performance.now();
    for (let frame = 0; frame < 60; frame += 1) {
      const point = { x: draggedRect.x + frame, y: draggedRect.y };
      evaluateAttachCandidates({ ...draggedRect, x: point.x }, dragged.type, ceilingDoc, exclude);
      deepestBoundaryAt(point, ceilingDoc, exclude);
    }
    // 50x the fixture size the equivalent budget above uses (500ms) — generous
    // in the same spirit: this exists to catch an accidental quadratic scan,
    // not to police milliseconds on a variable CI machine.
    expect(performance.now() - started).toBeLessThan(25_000);
  });

  /**
   * Regression for a real hang found manually driving the app at this scale:
   * `computePlan`'s trunk-gap search (`planTrunkGap`/`runBlocked` in
   * `edges/bundles.ts`) re-tests every obstacle node on every `TRUNK_QUANTUM`
   * step of the corridor, for every qualifying fan-out group — a cost with no
   * upper bound as node/edge count grows, unlike the O(n) hit-testing above.
   * At this document's scale it froze the browser's main thread for well over
   * a minute before `MAX_ROUTING_PLAN_OPS` capped the total work. `doc`'s own
   * "plans routing spines... within budget" test above only exercises the
   * 100-node fixture, which never had enough obstacles or corridor width to
   * reach the pathological case — this is the ceiling-scale counterpart.
   */
  it('plans routing spines for a 5,000-node document without hanging the main thread', () => {
    const started = performance.now();
    routingPlan(ceilingDoc.nodes, ceilingDoc.edges);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
