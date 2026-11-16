import { describe, expect, it } from 'vitest';
import { inferRelationship } from '../src/document/connectorSemantics';
import { dataDirection, lineageOf } from '../src/document/dataFlow';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { normalizeDocument } from '../src/document/validate';
import type { DraftNode } from '../src/document/types';
import { edgeMetaText } from '../src/edges/describe';
import { serializeDocument } from '../src/export/project';
import { buildStarter } from './fixtures/starters-v1/build';
import { starterById } from './fixtures/starters-v1';

const service = (text: string) => createNode({ type: 'service', text, x: 0, y: 0 });
const table = (text: string) => createNode({ type: 'database', databaseKind: 'table', text, x: 0, y: 0 });
const index = (...nodes: DraftNode[]) => new Map(nodes.map((n) => [n.id, n] as const));

describe('dataDirection', () => {
  const api = service('API');
  const store = createNode({ type: 'database', text: 'Orders', x: 0, y: 0 });
  const nodes = index(api, store);

  it('a read drawn from the reader carries data back along the line', () => {
    expect(dataDirection({ source: api.id, target: store.id, semantic: 'reads' }, nodes)).toBe('backward');
  });

  it('the same read drawn from the store ("read by") carries it with the arrow', () => {
    expect(dataDirection({ source: store.id, target: api.id, semantic: 'reads' }, nodes)).toBe('forward');
  });

  it('writes go into the store either way it is drawn', () => {
    expect(dataDirection({ source: api.id, target: store.id, semantic: 'writes' }, nodes)).toBe('forward');
    expect(dataDirection({ source: store.id, target: api.id, semantic: 'writes' }, nodes)).toBe('backward');
  });

  it('readsWrites is both, and a call follows its arrow', () => {
    expect(dataDirection({ source: api.id, target: store.id, semantic: 'readsWrites' }, nodes)).toBe('both');
    expect(dataDirection({ source: api.id, target: store.id, semantic: 'calls' }, nodes)).toBe('forward');
  });
});

describe('lineageOf', () => {
  it('follows data up to its sources and down to everything it feeds, through either drawing direction', () => {
    const source = createNode({ type: 'database', text: 'Source', x: 0, y: 0 });
    const ingest = service('Ingestion');
    const bronze = table('Bronze');
    const silver = table('Silver');
    const gold = table('Gold');
    const bi = service('BI');
    const unrelated = service('Unrelated');
    const edges = [
      // Drawn the call way: Ingestion reads Source. Data still flows Source → Ingestion.
      createEdge({ source: ingest.id, target: source.id, semantic: 'reads' }),
      createEdge({ source: ingest.id, target: bronze.id, semantic: 'writes' }),
      createEdge({ source: bronze.id, target: silver.id, semantic: 'transforms' }),
      createEdge({ source: silver.id, target: gold.id, semantic: 'transforms' }),
      createEdge({ source: bi.id, target: gold.id, semantic: 'reads' }),
      createEdge({ source: unrelated.id, target: bi.id, semantic: 'calls' }),
    ];
    const doc = addEdges(addNodes(createDocument('L'), [source, ingest, bronze, silver, gold, bi, unrelated]), edges);
    const lineage = lineageOf(doc, silver.id);
    expect(new Set(lineage.nodeIds)).toEqual(new Set([source.id, ingest.id, bronze.id, silver.id, gold.id, bi.id]));
    expect(lineage.edgeIds).toHaveLength(5);
  });
});

describe('table pipelines and cadence', () => {
  it('a table feeding a table transforms; an operational database landing in one still ingests', () => {
    expect(inferRelationship(table('Bronze'), table('Silver'))?.semantic).toBe('transforms');
    expect(inferRelationship(createNode({ type: 'database', x: 0, y: 0 }), table('Bronze'))?.semantic).toBe('ingests');
  });

  it('cadence shares the condition chip, and survives a save and load', () => {
    expect(edgeMetaText({ cadence: 'hourly' })).toBe('hourly');
    expect(edgeMetaText({ condition: 'paid', cadence: 'daily' })).toBe('[paid] · daily');
    expect(edgeMetaText({})).toBeNull();
    const a = table('A');
    const b = table('B');
    const doc = addEdges(addNodes(createDocument('C'), [a, b]), [{ ...createEdge({ source: a.id, target: b.id }), cadence: 'hourly' }]);
    const loaded = normalizeDocument(JSON.parse(serializeDocument(doc)));
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.document.edges[0]!.cadence).toBe('hourly');
  });

  it('the Medallion starter reads left to right as data, with Gold\'s lineage reaching every source', () => {
    const built = buildStarter(starterById('medallion')!, { x: 0, y: 0 });
    const doc = addEdges(addNodes(createDocument('M'), built.nodes), built.edges);
    const gold = doc.nodes.find((n) => n.text === 'Gold')!;
    const reached = new Set(lineageOf(doc, gold.id).nodeIds.map((id) => doc.nodes.find((n) => n.id === id)!.text));
    for (const name of ['Operational Database', 'Files', 'Event Stream', 'Ingestion', 'Bronze', 'Silver', 'Analytics / BI', 'Data API']) {
      expect(reached.has(name)).toBe(true);
    }
  });
});
