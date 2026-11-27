/**
 * The receipt judges a relationship caption where the canvas and export draw it. A request/response
 * connector's caption moves off its reply line's side — a single connector's reply too — and the
 * agent used to model it on the other side: below a horizontal line drawn with it above, and beside a
 * vertical one on the reply's side.
 */
import { describe, expect, it } from 'vitest';
import { captionSizer, edgeLabelSize, measureContext } from '../../src/agent/place';
import { drawnRoute } from '../../src/agent/route';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addEdges, addNodes } from '../../src/document/operations';
import { rectOf, routeBetween } from '../../src/edges/routing';
import { renderDocumentSvg } from '../../src/render/svg/document';

const CAPTION = () => ({ width: 60, height: 16 });

function pair(target: { x: number; y: number }) {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'Service A' });
  const b = createNode({ type: 'service', x: target.x, y: target.y, text: 'Service B' });
  const edge = createEdge({ source: a.id, target: b.id, semantic: 'calls', hasResponse: true });
  const doc = addEdges(addNodes(createDocument('Caption side'), [a, b]), [edge]);
  const line = routeBetween(rectOf(a), rectOf(b), edge.routing);
  const text = [...new DOMParser().parseFromString(renderDocumentSvg(doc).svg, 'image/svg+xml').querySelectorAll('text')].find(
    (t) => t.textContent === 'requests',
  );
  expect(text).toBeDefined();
  const chip = drawnRoute(edge, doc.nodes, doc.edges, CAPTION)?.chip;
  expect(chip).toBeTruthy();
  return { line, text: { x: Number(text!.getAttribute('x')), y: Number(text!.getAttribute('y')) }, chip: chip! };
}

describe('agent caption side', () => {
  it('models a horizontal reply connector\'s caption above its line, where the export draws it', () => {
    const { line, text, chip } = pair({ x: 460, y: 0 });
    expect(text.y).toBeLessThan(line.labelY);
    expect(chip.y + chip.height / 2).toBeLessThan(line.labelY);
  });

  it('models a vertical reply connector\'s caption on the side away from its reply line, where the export draws it', () => {
    const { line, text, chip } = pair({ x: 0, y: 320 });
    expect(text.x).toBeLessThan(line.labelX);
    expect(chip.x + chip.width / 2).toBeLessThan(line.labelX);
  });

  // Its chip shows the action's name, which every renderer routes (`routedLabel`); the checks sized and
  // placed its relationship caption instead, a box no renderer draws.
  it('judges a named recovery action by the name its chip shows, where the renderers place it', () => {
    const orders = createNode({ id: 'orders', type: 'service', x: 0, y: 0, text: 'Orders' });
    const pay = createNode({ id: 'pay', type: 'service', x: 500, y: 0, text: 'Payments' });
    const charge = createEdge({ id: 'charge', source: 'orders', target: 'pay', semantic: 'command' });
    const refund = { ...createEdge({ id: 'refund', source: 'orders', target: 'pay', semantic: 'compensates' }), compensationFor: 'charge', compensationName: 'Refund the payment' };
    const nodes = [orders, pay];
    const ctx = measureContext();
    // The same words as its own label: what the chip shows, routed and drawn the same way.
    const labelled = { ...refund, compensationName: undefined, label: 'Refund the payment' };
    const size = edgeLabelSize(refund, orders, pay, ctx);
    expect(size).toEqual(edgeLabelSize(labelled, orders, pay, ctx));
    expect(size.width).toBeGreaterThan(edgeLabelSize({ ...refund, compensationName: undefined }, orders, pay, ctx).width);
    const drawn = drawnRoute(refund, nodes, [charge, refund], captionSizer(nodes, ctx));
    expect(drawn).toMatchObject({ ownChip: true, chip: drawnRoute(labelled, nodes, [charge, labelled], captionSizer(nodes, ctx))!.chip });
  });
});
