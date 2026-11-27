import { describe, expect, it } from 'vitest';
import { ghostGraph, ghostRouteFor, ghostRouteInputs } from '../src/canvas/ghostRoutes';
import { projectEdges } from '../src/canvas/projection';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, updateEdge } from '../src/document/operations';
import { connectorRouteInputs } from '../src/edges/connectorRoutes';
import { describeEdge } from '../src/edges/describe';
import { edgeRoutes } from '../src/edges/edgeRoutes';
import { describeContext } from '../src/nodes/describe';
import { buildScene, renderDocumentSvg } from '../src/render/svg/document';
import { getMeasurer } from '../src/render/text/measure';
import { DARK } from '../src/render/theme/tokens';
import { visibleEdgesForPlayback } from '../src/presentation/visibleEdges';

describe('linked compensation visuals', () => {
  it('folds the action into its parent in canvas and SVG, then draws its distinct route when expanded', () => {
    const order = createNode({ type: 'service', text: 'Order service', x: 80, y: 120 });
    const inventory = createNode({ type: 'service', text: 'Inventory service', x: 520, y: 120 });
    const request = createEdge({ source: order.id, target: inventory.id, semantic: 'http', label: 'POST /reservations' });
    const undo = createEdge({
      source: order.id,
      target: inventory.id,
      semantic: 'compensates',
      compensationFor: request.id,
      compensationVisible: false,
      compensationName: 'Release reservation',
      label: 'POST /reservations/{id}/release',
    });
    const doc = addEdges(addNodes(createDocument('Reservation'), [order, inventory]), [request, undo]);
    const options = { selectedNodes: new Set<string>(), selectedEdges: new Set<string>(), interactive: true };
    const sceneOf = (current: typeof doc) => buildScene(current, describeContext(DARK, 'clean'), {
      theme: DARK,
      measurer: getMeasurer(),
      showSequence: false,
      preset: 'clean',
    });

    expect(projectEdges(doc, [], options).map((edge) => edge.id)).toEqual([request.id]);
    expect(sceneOf(doc).edgeEntries.map((entry) => entry.edge.id)).toEqual([request.id]);
    expect(renderDocumentSvg(doc).svg).not.toContain('↶');

    const expanded = updateEdge(doc, undo.id, { compensationVisible: true });
    expect(projectEdges(expanded, [], options).map((edge) => edge.id)).toEqual([request.id, undo.id]);
    const compensationLine = sceneOf(expanded).edgeEntries.find((entry) => entry.edge.id === undo.id)!.lineEls[0]!;
    expect(compensationLine.attrs?.['stroke-dasharray']).toBe('5 4');
    const exported = renderDocumentSvg(expanded).svg;
    expect(exported).toContain('Release reservation');
    expect(exported).toContain('POST /reservations/{id}/release');
    expect(exported).not.toContain('↶');
  });

  it('temporarily draws a folded action while its flow step plays', () => {
    const order = createNode({ type: 'service', text: 'Order service', x: 80, y: 120 });
    const inventory = createNode({ type: 'service', text: 'Inventory service', x: 520, y: 120 });
    const reserve = createEdge({ source: order.id, target: inventory.id, semantic: 'http', label: 'POST /reservations' });
    const release = createEdge({
      source: order.id,
      target: inventory.id,
      semantic: 'compensates',
      compensationFor: reserve.id,
      compensationVisible: false,
      label: 'POST /reservations/{id}/release',
    });
    const base = addEdges(addNodes(createDocument('Reservation saga'), [order, inventory]), [reserve, release]);
    const document = { ...base, flows: [{ id: 'rollback', title: 'Rollback', steps: [{ id: 'release-step', edgeId: release.id }] }] };
    const active = visibleEdgesForPlayback(document, { active: true, flowId: 'rollback', step: 1 });
    const stopped = visibleEdgesForPlayback(document, { active: false, flowId: null, step: 0 });
    const options = { selectedNodes: new Set<string>(), selectedEdges: new Set<string>(), interactive: false };

    expect(projectEdges(document, [], options, active).map((edge) => edge.id)).toEqual([reserve.id, release.id]);
    expect(projectEdges(document, [], options, stopped).map((edge) => edge.id)).toEqual([reserve.id]);
    expect(document.edges.find((edge) => edge.id === release.id)?.compensationVisible).toBe(false);
  });
});

describe('a named recovery action', () => {
  // Named but with no operation yet — what the inspector's "Name recovery action" leaves — and a shape
  // just above its line, where its words must not go.
  const orders = createNode({ id: 'orders', type: 'service', x: 0, y: 0, text: 'Orders' });
  const payments = createNode({ id: 'payments', type: 'service', x: 260, y: 260, text: 'Payments' });
  const refunds = createNode({ id: 'refunds', type: 'service', x: 640, y: 0, text: 'Refunds' });
  const audit = createNode({ id: 'audit', type: 'service', x: 360, y: -40, width: 120, height: 60, text: 'Audit' });
  const charge = createEdge({ id: 'charge', source: 'orders', target: 'payments', semantic: 'calls' });
  const refund = createEdge({
    id: 'refund',
    source: 'orders',
    target: 'refunds',
    semantic: 'compensates',
    compensationFor: 'charge',
    compensationVisible: true,
    compensationName: 'Refund the customer payment',
  });
  const doc = addEdges(addNodes(createDocument('Refunds'), [orders, payments, refunds, audit]), [charge, refund]);
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const ctx = { theme: DARK, measurer: getMeasurer(), showSequence: false };
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it('is routed for the name its chip shows by every reader, as the canvas routes it', () => {
    // The canvas routes the words it draws (`DraftEdgeView`: `routedLabel`); the export, agent checks,
    // overlays and previews routed the label, which a named action has none of.
    expect(connectorRouteInputs(refund, doc, 'transient')!.label).toBe('Refund the customer payment');
    expect(ghostRouteInputs(refund, ghostRouteFor(ghostGraph(doc.nodes, doc.edges), refund)!).label).toBe('Refund the customer payment');
    const inputs = connectorRouteInputs(refund, doc, 'transient')!;
    // Drawn from its own inputs (`routesOf`), the export lands the name where the accessor's routes do.
    const own = describeEdge(refund, byId, { ...ctx, obstacles: inputs.obstacles })!;
    const handed = describeEdge(refund, byId, { ...ctx, obstacles: inputs.obstacles, routes: edgeRoutes(inputs, 'transient') })!;
    expect(own.boxes.words).toEqual(handed.boxes.words);
  });

  it('keeps its exported name off the shape the canvas keeps it clear of', () => {
    const inputs = connectorRouteInputs(refund, doc, 'transient')!;
    const described = describeEdge(refund, byId, { ...ctx, obstacles: inputs.obstacles, routes: edgeRoutes(inputs, 'transient') })!;
    expect(described.boxes.words.length).toBeGreaterThan(0);
    expect(described.boxes.words.some((box) => overlaps(box, audit))).toBe(false);
  });
});
