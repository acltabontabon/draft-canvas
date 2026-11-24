import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { describeLegend, legendEntries } from '../src/edges/legend';
import { renderDocumentSvg } from '../src/render/svg/document';
import { LIGHT } from '../src/render/theme/tokens';

const edge = (id: string, extra: Record<string, unknown> = {}) => ({ ...createEdge({ id, source: 'a', target: 'b' }), ...extra });

describe('the legend', () => {
  it('lists only the kinds of line the diagram draws, plain ones first', () => {
    const entries = legendEntries([edge('1'), edge('2', { async: true }), edge('3', { kind: 'event' }), edge('4', { portal: true })]);
    expect(entries.map((entry) => entry.kind)).toEqual(['call', 'async', 'event', 'portal']);
    expect(entries.find((entry) => entry.kind === 'async')!.dash).toEqual([6, 4]);
    expect(entries.find((entry) => entry.kind === 'call')).toMatchObject({ label: 'Call', head: 'closed' });
  });

  it('has nothing to explain about a diagram drawn in one style', () => {
    expect(legendEntries([edge('1'), edge('2')])).toEqual([]);
    expect(legendEntries([])).toEqual([]);
    expect(describeLegend([edge('1')], { theme: LIGHT })).toBeNull();
  });

  it('names a reply line and a hollow head for what they are', () => {
    const entries = legendEntries([edge('1', { hasResponse: true }), edge('2', { kind: 'callback' }), edge('3', { directed: false })]);
    expect(entries.map((entry) => entry.kind)).toEqual(['call', 'link', 'reply', 'callback']);
    expect(entries.find((entry) => entry.kind === 'callback')!.head).toBe('open');
    expect(entries.find((entry) => entry.kind === 'link')!.head).toBe('none');
  });

  it('is a single row that grows with what it lists', () => {
    const two = describeLegend([edge('1'), edge('2', { async: true })], { theme: LIGHT })!;
    const three = describeLegend([edge('1'), edge('2', { async: true }), edge('3', { kind: 'event' })], { theme: LIGHT })!;
    expect(two.height).toBe(three.height);
    expect(three.width).toBeGreaterThan(two.width);
  });

  it('is drawn in an export only when asked for, below the diagram', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ id: 'b', type: 'queue', x: 400, y: 0, text: 'B' });
    const c = createNode({ id: 'c', type: 'service', x: 800, y: 0, text: 'C' });
    const doc = addEdges(addNodes(createDocument('Legend'), [a, b, c]), [edge('ab', { async: true }), { ...createEdge({ id: 'bc', source: 'b', target: 'c' }) }]);
    const without = renderDocumentSvg(doc, {});
    const withLegend = renderDocumentSvg(doc, { legend: true });
    expect(without.svg).not.toContain('Asynchronous');
    expect(withLegend.svg).toContain('Asynchronous');
    expect(withLegend.height).toBeGreaterThan(without.height);
  });
});
