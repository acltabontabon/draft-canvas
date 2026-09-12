import { describe, expect, it, vi } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftDocument } from '../src/document/types';

const downloadText = vi.fn();
vi.mock('../src/export/download', () => ({
  downloadText,
  downloadBlob: vi.fn(),
}));

const { exportSequenceMermaidFile, exportSequencePlantUmlFile, sequenceSourceFor, MERMAID_EXTENSION, PLANTUML_EXTENSION } =
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
