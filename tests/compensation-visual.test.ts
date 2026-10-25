import { describe, expect, it } from 'vitest';
import { projectEdges } from '../src/canvas/projection';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, updateEdge } from '../src/document/operations';
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
