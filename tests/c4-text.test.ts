/**
 * Schema v15's C4 text — `description` and `technology` on architecture shapes: read, kept, drawn,
 * and kept at every room level, exactly like every other node field.
 */
import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, DRAFT_FORMAT, type DraftNode } from '../src/document/types';
import { parseDocument } from '../src/document/validate';
import { createNode } from '../src/document/factory';
import { describeContext, describeNode, naturalArchitectureSize } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import { renderDocumentSvg } from '../src/render/svg/document';
import { createDocument } from '../src/document/factory';
import { walkGraphs } from '../src/depth/tree';

const shape = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'service', x: 0, y: 0, width: 176, height: 68, z: 0, text: id, ...extra });

function file(version: number, node: Record<string, unknown>) {
  // The node sits at the root and three rooms deep, each level holding its own copy.
  const room = (depth: number): Record<string, unknown> => ({
    nodes: [{ ...node, id: `${node.id}-${depth}`, ...(depth < 3 ? { inside: room(depth + 1) } : {}) }],
    edges: [],
    flows: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  return {
    format: DRAFT_FORMAT,
    version,
    metadata: { id: 'd1', title: 'C4', createdAt: 0, updatedAt: 0 },
    nodes: [{ ...node, inside: room(1) }],
    edges: [],
    flows: [],
    settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
  };
}

describe('C4 text in the document (v15)', () => {
  it('opens a v14 file unchanged, at the current version', () => {
    const result = parseDocument(JSON.stringify(file(14, shape('api'))));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.repairs).toEqual(['Upgraded document format from v14 to v15.']);
    expect(result.document.nodes[0]?.description).toBeUndefined();
  });

  it('keeps description and technology at the root and in every room below it', () => {
    const result = parseDocument(JSON.stringify(file(15, shape('api', { description: 'Takes orders.', technology: 'Spring Boot' }))));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seen: DraftNode[] = [];
    walkGraphs(result.document, (graph) => seen.push(...graph.nodes));
    expect(seen).toHaveLength(4);
    for (const node of seen) expect(node).toMatchObject({ description: 'Takes orders.', technology: 'Spring Boot' });
  });

  it('keeps them only on architecture shapes, trimmed, one line of technology, within limits', () => {
    const raw: { nodes: unknown[] } = file(15, shape('api'));
    raw.nodes = [
      shape('svc', { description: '  Takes orders.  ', technology: 'Spring\nBoot  3' }),
      { ...shape('note'), type: 'note', description: 'not a C4 element', technology: 'x' },
      shape('long', { technology: 'x'.repeat(200), description: 'y'.repeat(1000) }),
    ];
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [svc, note, long] = result.document.nodes;
    expect(svc).toMatchObject({ description: 'Takes orders.', technology: 'Spring Boot 3' });
    expect(note?.description).toBeUndefined();
    expect(long?.technology?.length).toBe(60);
    expect(long?.description?.length).toBe(280);
  });

  it('refuses to be opened by a reader older than the fields (the version moved)', () => {
    const newer = { ...file(15, shape('api')), version: CURRENT_VERSION + 1 };
    const result = parseDocument(JSON.stringify(newer));
    expect(result.ok).toBe(false);
  });
});

describe('C4 text on the canvas', () => {
  const ctx = describeContext(LIGHT);
  const texts = (node: DraftNode) =>
    describeNode(node, ctx).shapes.flatMap((s) => (s.t === 'text' ? [s.layout.lines.map((l) => l.text).join(' ')] : []));

  it('draws nothing new for a shape without it', () => {
    const plain = createNode({ type: 'service', x: 0, y: 0, text: 'Orders API' });
    expect(texts(plain)).toEqual(['Orders API']);
  });

  for (const type of ['service', 'database', 'queue', 'actor', 'component'] as const) {
    it(`draws name, [technology] and description on a ${type}, once the shape is its natural size`, () => {
      const node = createNode({ type, x: 0, y: 0, text: 'Orders', technology: 'PostgreSQL', description: 'Every order, append-only.' });
      const natural = naturalArchitectureSize(node, ctx);
      expect(natural.fits).toBe(true);
      const drawn = texts({ ...node, width: natural.width, height: natural.height }).join('').replace(/\s+/g, '');
      expect(drawn).toContain('Orders');
      expect(drawn).toContain('[PostgreSQL]');
      expect(drawn).toContain('Everyorder,append-only.');
    });
  }

  it('exports the same text to SVG as it draws', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, text: 'Orders API', technology: 'Kotlin', description: 'Takes orders.' });
    const sized = { ...node, ...naturalArchitectureSize(node, ctx) };
    const doc = { ...createDocument('C4'), nodes: [sized] };
    const { svg } = renderDocumentSvg(doc, { theme: 'light' } as never);
    expect(svg).toContain('[Kotlin]');
    expect(svg).toContain('Takes orders.');
  });
});
