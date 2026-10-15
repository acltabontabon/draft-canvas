/**
 * The receipt judges a relationship caption where the canvas and export draw it. A request/response
 * connector's caption moves off its reply line's side — a single connector's reply too — and the
 * agent used to model it on the other side: below a horizontal line drawn with it above, and beside a
 * vertical one on the reply's side.
 */
import { describe, expect, it } from 'vitest';
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
});
