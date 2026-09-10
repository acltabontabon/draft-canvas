import { describe, expect, it } from 'vitest';
import { offerFor, quickConnectItems } from '../src/canvas/quickConnectItems';
import { inferRelationship } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import type { QuickConnectState } from '../src/store/uiStore';

function topicDoc() {
  const pub = createNode({ id: 'pub', type: 'service', x: 0, y: 0 });
  const topic = createNode({ id: 't', type: 'queue', queueKind: 'topic', x: 400, y: 0 });
  let doc = addNodes(createDocument('Q'), [pub, topic]);
  doc = addEdges(doc, [createEdge({ source: 'pub', target: 't', ...inferRelationship(pub, topic) })]);
  return doc;
}

const drop = (source?: string): QuickConnectState => ({
  source,
  sourceSide: 'right',
  sourceOffset: 0.5,
  flowPosition: { x: 712, y: -34 },
  screenPosition: { x: 800, y: 300 },
  center: { x: 800, y: 0 },
});

describe('quickConnectItems', () => {
  it('leads with the engine\'s offers, then the presets a suggestion does not already stand in for', () => {
    const rows = quickConnectItems(topicDoc(), drop('t'));
    expect(rows.map((r) => `${r.kind}:${r.label}`)).toEqual([
      'continuation:Queue',
      'continuation:Worker',
      'preset:Service',
      'preset:Data Store',
      'preset:Actor',
    ]);
  });

  it('is presets only for a picker with no source, and for a source with nothing to suggest', () => {
    expect(quickConnectItems(topicDoc(), drop()).map((r) => r.kind)).toEqual(['preset', 'preset', 'preset', 'preset']);
    expect(quickConnectItems(topicDoc(), drop('pub')).map((r) => r.label)).toEqual(['Service', 'Data Store', 'Queue', 'Actor']);
  });
});

describe('offerFor', () => {
  it('centres any row on the drop point and infers the connector from the matrix', () => {
    const doc = topicDoc();
    const rows = quickConnectItems(doc, drop('t'));
    const queue = offerFor(doc, drop('t'), rows[0]!)!;
    expect(queue.trigger).toBe('drop');
    expect(queue.nodes[0]!.x).toBe(800 - 140 / 2);
    expect(queue.nodes[0]!.y).toBe(0 - 48 / 2);
    expect(queue.edges[0]!.semantic).toBe('fansOut');

    const actor = offerFor(doc, drop('t'), rows.find((r) => r.label === 'Actor')!)!;
    expect(actor.nodes[0]!.type).toBe('actor');
    expect(actor.nodes[0]!.x).toBe(800 - 120 / 2);
    // No matrix row for topic → actor: the connector is created plain, as a hand-drawn one would be.
    expect(actor.edges[0]!.semantic).toBeUndefined();
    expect(actor.edges[0]!.source).toBe('t');
  });

  it('is nothing for a picker with no source', () => {
    const doc = topicDoc();
    expect(offerFor(doc, drop(), quickConnectItems(doc, drop())[0]!)).toBeUndefined();
  });
});
