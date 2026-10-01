import { describe, expect, it, vi } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftDocument } from '../src/document/types';

const downloadText = vi.fn();
vi.mock('../src/export/download', () => ({
  downloadText,
  downloadBlob: vi.fn(),
}));

const { countPlayableFlows, exportSequenceMermaidFile, exportSequencePlantUmlFile, sequenceSourceFor, MERMAID_EXTENSION, PLANTUML_EXTENSION } =
  await import('../src/export/sequence');

function fixture(title: string): DraftDocument {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  const edge = createEdge({ source: a.id, target: b.id, label: 'Go' });
  const flow = createFlow({ title: 'Flow' });
  flow.steps = [{ id: 'fs1', edgeId: edge.id }];
  return { ...createDocument(title), nodes: [a, b], edges: [edge], flows: [flow] };
}

describe('sequenceSourceFor', () => {
  it('produces Mermaid source for the "mermaid" format', () => {
    const out = sequenceSourceFor(fixture('Payment Saga'), 'mermaid');
    expect(out).toContain('sequenceDiagram');
    expect(out).toContain('Go');
  });

  it('produces PlantUML source for the "plantuml" format', () => {
    const out = sequenceSourceFor(fixture('Payment Saga'), 'plantuml');
    expect(out).toContain('@startuml');
    expect(out).toContain('Go');
  });

  it('is deterministic — the same document always produces byte-identical source', () => {
    const doc = fixture('Payment Saga');
    expect(sequenceSourceFor(doc, 'mermaid')).toBe(sequenceSourceFor(doc, 'mermaid'));
    expect(sequenceSourceFor(doc, 'plantuml')).toBe(sequenceSourceFor(doc, 'plantuml'));
  });
});

describe('exportSequenceMermaidFile / exportSequencePlantUmlFile', () => {
  it('downloads with the .mmd extension and a normalized filename', () => {
    downloadText.mockClear();
    exportSequenceMermaidFile(fixture('Payment Saga!!'));

    expect(downloadText).toHaveBeenCalledTimes(1);
    const [text, fileName, mime] = downloadText.mock.calls[0]!;
    expect(fileName).toBe('payment-saga.mmd');
    expect(text).toContain('sequenceDiagram');
    expect(mime).toBe('text/plain');
  });

  it('downloads with the .puml extension and a normalized filename', () => {
    downloadText.mockClear();
    exportSequencePlantUmlFile(fixture('Payment Saga!!'));

    expect(downloadText).toHaveBeenCalledTimes(1);
    const [text, fileName] = downloadText.mock.calls[0]!;
    expect(fileName).toBe('payment-saga.puml');
    expect(text).toContain('@startuml');
  });

  it('extension constants carry the documented naming convention', () => {
    expect(MERMAID_EXTENSION).toBe('.mmd');
    expect(PLANTUML_EXTENSION).toBe('.puml');
  });

  it('an empty title falls back to the shared "draft-canvas" filename base', () => {
    downloadText.mockClear();
    exportSequenceMermaidFile(fixture(''));

    const [, fileName] = downloadText.mock.calls[0]!;
    expect(fileName).toBe('draft-canvas.mmd');
  });
});

describe('sequenceSourceFor — every room', () => {
  function twoRooms(): DraftDocument {
    const inner1 = createNode({ type: 'component', x: 0, y: 0, text: 'Validator' });
    const inner2 = createNode({ type: 'component', x: 200, y: 0, text: 'Writer' });
    const innerEdge = createEdge({ source: inner1.id, target: inner2.id, label: 'Persist' });
    const innerFlow = createFlow({ title: 'Inside' });
    innerFlow.steps = [{ id: 'fs2', edgeId: innerEdge.id }];
    const ordersApi = {
      ...createNode({ type: 'service', x: 0, y: 0, text: 'Orders API' }),
      inside: { nodes: [inner1, inner2], edges: [innerEdge], flows: [innerFlow], viewport: { x: 0, y: 0, zoom: 1 } },
    };
    const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
    const edge = createEdge({ source: ordersApi.id, target: b.id, label: 'Go' });
    const flow = createFlow({ title: 'Outside' });
    flow.steps = [{ id: 'fs1', edgeId: edge.id }];
    return { ...createDocument('Checkout'), nodes: [ordersApi, b], edges: [edge], flows: [flow] };
  }

  it('emits one section per room in tree order, each under a comment naming the room', () => {
    const out = sequenceSourceFor(twoRooms(), 'mermaid');
    const rootAt = out.indexOf('%% Room: Checkout\n');
    const innerAt = out.indexOf('%% Room: Checkout / Orders API\n');
    expect(rootAt).toBe(0);
    expect(innerAt).toBeGreaterThan(rootAt);
    expect(out.match(/^sequenceDiagram$/gm)).toHaveLength(2);
    // Each room's flows read exactly as a flat canvas's would, and the blocks are kept apart.
    expect(out.indexOf('Go')).toBeLessThan(innerAt);
    expect(out.indexOf('Persist')).toBeGreaterThan(innerAt);
    expect(out).toContain('\n\n%% Room: Checkout / Orders API\n');
  });

  it('uses the PlantUML comment for PlantUML, one diagram per room', () => {
    const out = sequenceSourceFor(twoRooms(), 'plantuml');
    expect(out).toContain("' Room: Checkout\n");
    expect(out).toContain("' Room: Checkout / Orders API\n");
    expect(out.match(/^@startuml$/gm)).toHaveLength(2);
    expect(out.match(/^@enduml$/gm)).toHaveLength(2);
  });

  it('skips a room with nothing to play, and a flat canvas reads exactly as before', () => {
    const doc = twoRooms();
    const quietInside = { ...doc, nodes: [{ ...doc.nodes[0]!, inside: { ...doc.nodes[0]!.inside!, flows: [] } }, doc.nodes[1]!] };
    const out = sequenceSourceFor(quietInside, 'mermaid');
    expect(out).toContain('%% Room: Checkout\n');
    expect(out).not.toContain('%% Room: Checkout / Orders API');
    expect(out.match(/^sequenceDiagram$/gm)).toHaveLength(1);

    expect(sequenceSourceFor(fixture('Flat'), 'mermaid')).not.toContain('Room:');
  });

  it('counts playable Flows across every room', () => {
    expect(countPlayableFlows(twoRooms())).toBe(2);
    expect(countPlayableFlows(fixture('Flat'))).toBe(1);
    expect(countPlayableFlows(createDocument('Empty'))).toBe(0);
  });
});
