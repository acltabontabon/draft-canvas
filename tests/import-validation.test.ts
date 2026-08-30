import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/document/validate';
import { CURRENT_VERSION, DRAFT_FORMAT } from '../src/document/types';
import { LIMITS } from '../src/document/limits';

const base = { format: DRAFT_FORMAT, version: CURRENT_VERSION };

function parse(payload: unknown) {
  return parseDocument(JSON.stringify(payload));
}

describe('importing untrusted files', () => {
  it('refuses anything that is not a Draft Canvas document', () => {
    expect(parseDocument('not json at all').ok).toBe(false);
    expect(parse({ hello: 'world' }).ok).toBe(false);
    expect(parse([1, 2, 3]).ok).toBe(false);
    expect(parseDocument(null).ok).toBe(false);
  });

  it('explains a version it cannot read instead of failing obscurely', () => {
    const result = parse({ ...base, version: 99, nodes: [], edges: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('newer version');
    expect(result.error).toContain('v99');
  });

  it('opens a valid document with no repairs', () => {
    const result = parse({
      ...base,
      metadata: { id: 'doc1', title: 'Flow', createdAt: 1, updatedAt: 2 },
      nodes: [{ id: 'a', type: 'card', x: 0, y: 0, width: 100, height: 50, z: 0, text: 'A' }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { showSequence: true, grid: 'dots' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    expect(result.document.nodes).toHaveLength(1);
  });

  it('preserves an explicit neutral accent instead of falling back to the type default', () => {
    // Regression test: a node's accent is an explicit override of its type's
    // default colour (teal for a service, blue for a database, ...), and
    // `neutral` (grey) is one of the choices a user can make — not a synonym
    // for "no accent set". Every save/reload round trip passes through here,
    // so treating them as the same collapsed an explicit choice of grey back
    // into the type's own default colour on every reload.
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, accent: 'neutral' },
        { id: 'b', type: 'database', x: 200, y: 0, accent: 'rose' },
        { id: 'c', type: 'card', x: 400, y: 0 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', accent: 'neutral' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [service, database, card] = result.document.nodes;
    expect(service!.accent).toBe('neutral');
    expect(database!.accent).toBe('rose');
    // No accent was ever set on this one — it must stay unset, not become
    // explicitly neutral, so the type's own default still applies to it.
    expect(card!.accent).toBeUndefined();
    expect(result.document.edges[0]!.accent).toBe('neutral');
  });

  it('drops connections that point at nodes which do not exist', () => {
    const result = parse({
      ...base,
      nodes: [{ id: 'a', type: 'card', x: 0, y: 0 }],
      edges: [
        { id: 'e1', source: 'a', target: 'ghost' },
        { id: 'e2', source: 'ghost', target: 'a' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges).toHaveLength(0);
    expect(result.repairs.join(' ')).toContain('2 connection(s)');
  });

  it('gives duplicate node ids fresh identities', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'same', type: 'card', x: 0, y: 0 },
        { id: 'same', type: 'card', x: 100, y: 0 },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.document.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
    expect(result.repairs.join(' ')).toContain('new ids');
  });

  it('detaches grouping links that are dangling, self-referential or cyclic', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'card', x: 0, y: 0, parentId: 'missing' },
        { id: 'b', type: 'card', x: 0, y: 0, parentId: 'b' },
        { id: 'c', type: 'card', x: 0, y: 0, parentId: 'd' },
        { id: 'd', type: 'card', x: 0, y: 0, parentId: 'c' },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No node may still sit in a parent chain that loops back to itself.
    const byId = new Map(result.document.nodes.map((node) => [node.id, node]));
    for (const node of result.document.nodes) {
      const seen = new Set([node.id]);
      let cursor = node.parentId ? byId.get(node.parentId) : undefined;
      while (cursor) {
        expect(seen.has(cursor.id)).toBe(false);
        seen.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
    }
  });

  it('coerces an unknown node type rather than losing the content', () => {
    const result = parse({
      ...base,
      nodes: [{ id: 'a', type: 'quantum-widget', x: 0, y: 0, text: 'Keep me' }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]!.type).toBe('card');
    expect(result.document.nodes[0]!.text).toBe('Keep me');
  });

  it('repairs nonsense numbers instead of letting NaN reach the canvas', () => {
    const result = parse({
      ...base,
      nodes: [
        {
          id: 'a',
          type: 'card',
          x: 'over there',
          y: null,
          width: -50,
          height: Number.MAX_VALUE,
          z: 1e9,
        },
      ],
      edges: [],
      viewport: { x: 'nope', y: 0, zoom: 9999 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const node = result.document.nodes[0]!;
    for (const value of [node.x, node.y, node.width, node.height, node.z]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(node.width).toBeGreaterThanOrEqual(LIMITS.minNodeSize);
    expect(node.height).toBeLessThanOrEqual(LIMITS.maxNodeSize);
    expect(result.document.viewport.zoom).toBeLessThanOrEqual(LIMITS.maxZoom);
    expect(Number.isFinite(result.document.viewport.x)).toBe(true);
  });

  it('strips control characters from text but keeps newlines and tabs', () => {
    const result = parse({
      ...base,
      nodes: [
        {
          id: 'a',
          type: 'code',
          x: 0,
          y: 0,
          language: 'json',
          code: 'line one\n\tindented \u0000\u0007 end',
        },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const code = result.document.nodes[0]!.code!;
    expect(code).toContain('\n');
    expect(code).toContain('\t');
    expect(code).not.toContain('\u0000');
    expect(code).not.toContain('\u0007');
    expect(code).toContain('indented');
  });

  it('truncates oversized strings', () => {
    const result = parse({
      ...base,
      metadata: { title: 'T'.repeat(5000) },
      nodes: [{ id: 'a', type: 'card', x: 0, y: 0, text: 'x'.repeat(LIMITS.maxTextLength + 500) }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.metadata.title.length).toBeLessThanOrEqual(LIMITS.maxTitleLength);
    expect(result.document.nodes[0]!.text!.length).toBeLessThanOrEqual(LIMITS.maxTextLength);
  });

  it('refuses a file larger than the import limit', () => {
    const result = parseDocument('x'.repeat(LIMITS.maxFileBytes + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('too large');
  });

  it('survives malformed entries in the node and edge arrays', () => {
    const result = parse({
      ...base,
      nodes: [null, 'a string', 42, { id: 'ok', type: 'card', x: 0, y: 0 }],
      edges: [null, { id: 'e', source: 'ok', target: 'ok' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes).toHaveLength(1);
    expect(result.document.edges).toHaveLength(1);
  });

  it('renumbers a sparse sequence into contiguous steps', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'card', x: 0, y: 0 },
        { id: 'b', type: 'card', x: 100, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', sequence: 40 },
        { id: 'e2', source: 'b', target: 'a', sequence: 7 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges.map((edge) => edge.sequence).sort()).toEqual([1, 2]);
    // Relative order is preserved: the edge numbered 7 becomes step 1.
    expect(result.document.edges.find((edge) => edge.id === 'e2')!.sequence).toBe(1);
  });

  it('coerces an unknown node variant to its default, and always sets one', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 's1', type: 'service', x: 0, y: 0, serviceKind: 'mainframe' },
        { id: 's2', type: 'service', x: 0, y: 0, serviceKind: 'api' },
        { id: 'd1', type: 'database', x: 0, y: 0, databaseKind: 'graphql' },
        { id: 'd2', type: 'database', x: 0, y: 0, databaseKind: 'sql' },
        { id: 'q1', type: 'queue', x: 0, y: 0, queueKind: 'mailbox' },
        { id: 'q2', type: 'queue', x: 0, y: 0, queueKind: 'stream' },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = (id: string) => result.document.nodes.find((n) => n.id === id)!;
    expect(byId('s1').serviceKind).toBe('generic');
    expect(byId('s2').serviceKind).toBe('api');
    expect(byId('d1').databaseKind).toBe('generic');
    expect(byId('d2').databaseKind).toBe('sql');
    expect(byId('q1').queueKind).toBe('queue');
    expect(byId('q2').queueKind).toBe('stream');
  });

  it('coerces an unknown boundary preset to the default, and always sets one on a group', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'g1', type: 'group', x: 0, y: 0, width: 300, height: 200, boundaryPreset: 'kubernetes' },
        { id: 'g2', type: 'group', x: 0, y: 0, width: 300, height: 200 },
        { id: 'g3', type: 'group', x: 0, y: 0, width: 300, height: 200, boundaryPreset: 'domain' },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.find((n) => n.id === 'g1')!.boundaryPreset).toBe('boundary');
    expect(result.document.nodes.find((n) => n.id === 'g2')!.boundaryPreset).toBe('boundary');
    expect(result.document.nodes.find((n) => n.id === 'g3')!.boundaryPreset).toBe('domain');
  });

  it('treats hostile payloads as content, never as code', () => {
    const result = parse({
      ...base,
      nodes: [
        {
          id: 'a',
          type: 'code',
          x: 0,
          y: 0,
          language: 'java',
          code: '<script>globalThis.__pwned = true</script>',
          text: '<img src=x onerror=alert(1)>',
        },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]!.code).toBe('<script>globalThis.__pwned = true</script>');
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
