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
      nodes: [{ id: 'a', type: 'note', x: 0, y: 0, width: 100, height: 50, z: 0, text: 'A' }],
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
        { id: 'c', type: 'note', x: 400, y: 0 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', accent: 'neutral' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [service, database, plain] = result.document.nodes;
    expect(service!.accent).toBe('neutral');
    expect(database!.accent).toBe('rose');
    // No accent was ever set on this one — it must stay unset, not become
    // explicitly neutral, so the type's own default still applies to it.
    expect(plain!.accent).toBeUndefined();
    expect(result.document.edges[0]!.accent).toBe('neutral');
  });

  it('drops connections that point at nodes which do not exist', () => {
    const result = parse({
      ...base,
      nodes: [{ id: 'a', type: 'note', x: 0, y: 0 }],
      edges: [
        { id: 'e1', source: 'a', target: 'ghost' },
        { id: 'e2', source: 'ghost', target: 'a' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges).toHaveLength(0);
    expect(result.repairs.join(' ')).toContain('2 connector(s)');
  });

  it('drops a self-referencing connection (source equal to target)', () => {
    // In-app `connect()` already refuses to create one of these, but a file
    // — hand-edited or written by a different tool — can still contain one,
    // and nothing downstream expects a connector with the same node at both
    // ends.
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'note', x: 0, y: 0 },
        { id: 'b', type: 'note', x: 200, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges).toHaveLength(1);
    expect(result.document.edges[0]!.id).toBe('e2');
    expect(result.repairs.join(' ')).toContain('pointed a node at itself');
  });

  it('gives duplicate node ids fresh identities', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'same', type: 'note', x: 0, y: 0 },
        { id: 'same', type: 'note', x: 100, y: 0 },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.document.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
    expect(result.repairs.join(' ')).toContain('new ids');
  });

  it('gives duplicate flow ids fresh identities', () => {
    const result = parse({
      ...base,
      nodes: [],
      edges: [],
      flows: [
        { id: 'same', title: 'First', steps: [] },
        { id: 'same', title: 'Second', steps: [] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.document.flows.map((flow) => flow.id);
    expect(new Set(ids).size).toBe(2);
    // Both flows must survive with their own titles intact — this is an id
    // collision to repair, not a reason to drop either flow.
    expect(result.document.flows.map((flow) => flow.title).sort()).toEqual(['First', 'Second']);
  });

  it('detaches grouping links that are dangling, self-referential or cyclic', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'note', x: 0, y: 0, parentId: 'missing' },
        { id: 'b', type: 'note', x: 0, y: 0, parentId: 'b' },
        { id: 'c', type: 'note', x: 0, y: 0, parentId: 'd' },
        { id: 'd', type: 'note', x: 0, y: 0, parentId: 'c' },
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

  it('keeps a parent link that only leads into a cycle, and drops one to a non-boundary', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'c', type: 'group', x: 0, y: 0, parentId: 'a' },
        { id: 'a', type: 'group', x: 0, y: 0, parentId: 'b' },
        { id: 'b', type: 'group', x: 0, y: 0, parentId: 'a' },
        { id: 'svc', type: 'service', x: 0, y: 0 },
        { id: 'note', type: 'note', x: 0, y: 0, parentId: 'svc' },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.document.nodes.map((node) => [node.id, node]));
    expect(byId.get('c')!.parentId).toBe('a');
    expect([byId.get('a')!.parentId, byId.get('b')!.parentId].filter(Boolean)).toHaveLength(1);
    expect(byId.get('note')!.parentId).toBeUndefined();
  });

  it('coerces an unknown node type rather than losing the content', () => {
    const result = parse({
      ...base,
      nodes: [{ id: 'a', type: 'quantum-widget', x: 0, y: 0, text: 'Keep me' }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]!.type).toBe('note');
    expect(result.document.nodes[0]!.text).toBe('Keep me');
  });

  it('repairs nonsense numbers instead of letting NaN reach the canvas', () => {
    const result = parse({
      ...base,
      nodes: [
        {
          id: 'a',
          type: 'note',
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

  it('repairs malformed attachments instead of letting them poison the node', () => {
    const result = parse({
      ...base,
      nodes: [
        {
          id: 'a',
          type: 'service',
          x: 0,
          y: 0,
          attachments: [
            'not an object',
            { id: 'dup', type: 'note', text: 'first' },
            { id: 'dup', type: 'note', text: 'second, same id as the one before' },
            { type: 'bogus-type', text: 'unknown attachment type' },
            { id: 'sized', type: 'note', width: 'nope', height: -999999 },
            ...Array.from({ length: LIMITS.maxAttachmentsPerNode + 5 }, (_, i) => ({
              id: `extra${i}`,
              type: 'note',
              text: `overflow ${i}`,
            })),
          ],
        },
      ],
      edges: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attachments = result.document.nodes[0]!.attachments ?? [];
    // Capped, non-object entries dropped, and every surviving id is unique.
    expect(attachments.length).toBeLessThanOrEqual(LIMITS.maxAttachmentsPerNode);
    expect(new Set(attachments.map((a) => a.id)).size).toBe(attachments.length);
    for (const attachment of attachments) {
      if (attachment.width !== undefined) expect(Number.isFinite(attachment.width)).toBe(true);
      if (attachment.height !== undefined) expect(Number.isFinite(attachment.height)).toBe(true);
    }
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
      nodes: [{ id: 'a', type: 'note', x: 0, y: 0, text: 'x'.repeat(LIMITS.maxTextLength + 500) }],
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
      nodes: [
        null,
        'a string',
        42,
        { id: 'ok', type: 'note', x: 0, y: 0 },
        { id: 'ok2', type: 'note', x: 200, y: 0 },
      ],
      edges: [null, { id: 'e', source: 'ok', target: 'ok2' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes).toHaveLength(2);
    expect(result.document.edges).toHaveLength(1);
  });

  it('drops a flow step referencing a connection that does not exist, keeping the rest in order', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'note', x: 0, y: 0 },
        { id: 'b', type: 'note', x: 100, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
      flows: [
        {
          id: 'f1',
          title: 'Walkthrough',
          steps: [
            { id: 's1', edgeId: 'e1' },
            { id: 's2', edgeId: 'missing' },
            { id: 's3', edgeId: 'e2' },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows).toHaveLength(1);
    expect(result.document.flows[0]!.steps.map((s) => s.edgeId)).toEqual(['e1', 'e2']);
  });

  it('says so when flows or steps past the caps are cut, instead of dropping them silently', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'note', x: 0, y: 0 },
        { id: 'b', type: 'note', x: 100, y: 0 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      flows: Array.from({ length: LIMITS.maxFlows + 1 }, (_, i) => ({
        id: `f${i}`,
        title: `Flow ${i}`,
        steps:
          i === 0
            ? Array.from({ length: LIMITS.maxStepsPerFlow + 5 }, (_, j) => ({ id: `s${j}`, viewport: { x: j, y: 0, zoom: 1 } }))
            : [],
      })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows).toHaveLength(LIMITS.maxFlows);
    expect(result.document.flows[0]!.steps).toHaveLength(LIMITS.maxStepsPerFlow);
    expect(result.repairs.some((r) => r.includes('too many flows'))).toBe(true);
    expect(result.repairs.some((r) => r.includes('too many steps'))).toBe(true);
  });

  it('reads a "frame" step with extraNodeIds/extraEdgeIds/viewport and no primary edgeId', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'a', type: 'note', x: 0, y: 0 },
        { id: 'b', type: 'note', x: 100, y: 0 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      flows: [
        {
          id: 'f1',
          title: 'Overview',
          steps: [
            {
              id: 's1',
              extraNodeIds: ['a', 'b'],
              extraEdgeIds: ['e1'],
              viewport: { x: 12, y: -5, zoom: 2 },
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.document.flows[0]!.steps[0]!;
    expect(step.edgeId).toBeUndefined();
    expect(step.extraNodeIds).toEqual(['a', 'b']);
    expect(step.extraEdgeIds).toEqual(['e1']);
    expect(step.viewport).toEqual({ x: 12, y: -5, zoom: 2 });
  });

  it('keeps a step whose primary edge is dangling but whose extras still resolve', () => {
    const result = parse({
      ...base,
      nodes: [{ id: 'a', type: 'note', x: 0, y: 0 }],
      edges: [],
      flows: [
        { id: 'f1', title: 'X', steps: [{ id: 's1', edgeId: 'missing', extraNodeIds: ['a'] }] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows[0]!.steps).toHaveLength(1);
    expect(result.document.flows[0]!.steps[0]!.edgeId).toBeUndefined();
    expect(result.document.flows[0]!.steps[0]!.extraNodeIds).toEqual(['a']);
  });

  it('drops extraNodeIds/extraEdgeIds entries pointing at nodes/edges that do not exist', () => {
    const result = parse({
      ...base,
      nodes: [{ id: 'a', type: 'note', x: 0, y: 0 }],
      edges: [{ id: 'e1', source: 'a', target: 'a' }],
      flows: [
        {
          id: 'f1',
          title: 'X',
          steps: [{ id: 's1', edgeId: 'e1', extraNodeIds: ['a', 'gone'], extraEdgeIds: ['gone'] }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows[0]!.steps[0]!.extraNodeIds).toEqual(['a']);
    expect(result.document.flows[0]!.steps[0]!.extraEdgeIds).toBeUndefined();
  });

  it('caps extraNodeIds/extraEdgeIds at LIMITS.maxExtraMembersPerStep', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, type: 'note', x: i, y: 0 }));
    const result = parse({
      ...base,
      nodes,
      edges: [],
      flows: [
        {
          id: 'f1',
          title: 'X',
          steps: [{ id: 's1', extraNodeIds: nodes.map((n) => n.id) }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows[0]!.steps[0]!.extraNodeIds).toHaveLength(LIMITS.maxExtraMembersPerStep);
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
        { id: 'a1', type: 'actor', x: 0, y: 0, actorKind: 'robot' },
        { id: 'a2', type: 'actor', x: 0, y: 0, actorKind: 'device' },
        { id: 'c1', type: 'component', x: 0, y: 0, componentKind: 'microservice' },
        { id: 'c2', type: 'component', x: 0, y: 0, componentKind: 'adapter' },
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
    expect(byId('a1').actorKind).toBe('human');
    expect(byId('a2').actorKind).toBe('device');
    expect(byId('c1').componentKind).toBe('generic');
    expect(byId('c2').componentKind).toBe('adapter');
  });

  it('keeps deliveryRole on a queue node but drops it from any other node type', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'q1', type: 'queue', x: 0, y: 0, deliveryRole: 'dead-letter' },
        { id: 'q2', type: 'queue', x: 0, y: 0, deliveryRole: 'bogus' },
        { id: 's1', type: 'service', x: 0, y: 0, deliveryRole: 'dead-letter' },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = (id: string) => result.document.nodes.find((n) => n.id === id)!;
    expect(byId('q1').deliveryRole).toBe('dead-letter');
    expect(byId('q2').deliveryRole).toBeUndefined();
    expect(byId('s1').deliveryRole).toBeUndefined();
  });

  it('round-trips a deadLetters edge and clamps a corrupted deliveryAttempts', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 'q1', type: 'queue', x: 0, y: 0 },
        { id: 'q2', type: 'queue', x: 0, y: 0, deliveryRole: 'dead-letter' },
        { id: 'q3', type: 'queue', x: 0, y: 0, deliveryRole: 'dead-letter' },
        { id: 'q4', type: 'queue', x: 0, y: 0, deliveryRole: 'dead-letter' },
        { id: 'q5', type: 'queue', x: 0, y: 0, deliveryRole: 'dead-letter' },
      ],
      edges: [
        { id: 'e1', source: 'q1', target: 'q2', semantic: 'deadLetters', kind: 'failure', async: true, deliveryAttempts: 3 },
        { id: 'e2', source: 'q1', target: 'q3', semantic: 'deadLetters', deliveryAttempts: 0 },
        { id: 'e3', source: 'q1', target: 'q4', semantic: 'deadLetters', deliveryAttempts: 9999 },
        { id: 'e4', source: 'q1', target: 'q5', semantic: 'deadLetters', deliveryAttempts: 'three' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = (id: string) => result.document.edges.find((e) => e.id === id)!;
    expect(byId('e1')).toMatchObject({ semantic: 'deadLetters', kind: 'failure', async: true, deliveryAttempts: 3 });
    expect(byId('e2').deliveryAttempts).toBe(1);
    expect(byId('e3').deliveryAttempts).toBe(50);
    expect(byId('e4').deliveryAttempts).toBeUndefined();
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

  it('an old document with no text-role fields loads with no repairs and no fields fabricated', () => {
    const result = parse({
      ...base,
      nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 120, height: 30, text: 'API' }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    const node = result.document.nodes[0]!;
    expect(node.textRole).toBeUndefined();
    expect(node.textAlign).toBeUndefined();
    expect(node.textBold).toBeUndefined();
    expect(node.textItalic).toBeUndefined();
  });

  it('keeps a valid textRole/textAlign and coerces an unknown one away rather than rejecting the node', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 't1', type: 'text', x: 0, y: 0, textRole: 'heading', textAlign: 'center', textBold: true, textItalic: true },
        { id: 't2', type: 'text', x: 0, y: 0, textRole: 'shouty', textAlign: 'diagonal' },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = (id: string) => result.document.nodes.find((n) => n.id === id)!;
    expect(byId('t1')).toMatchObject({ textRole: 'heading', textAlign: 'center', textBold: true, textItalic: true });
    expect(byId('t2').textRole).toBeUndefined();
    expect(byId('t2').textAlign).toBeUndefined();
  });

  it('textRole/textAlign/textBold/textItalic only ever apply to text nodes', () => {
    const result = parse({
      ...base,
      nodes: [
        { id: 's1', type: 'service', x: 0, y: 0, textRole: 'title', textBold: true },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0]!;
    expect(node.textRole).toBeUndefined();
    expect(node.textBold).toBeUndefined();
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

/**
 * A room is validated by the same rules as the document holding it — these cover what only
 * nesting can get wrong: how deep a hand-edited file may go, which shapes may hold a room at all,
 * ids that repeat between rooms, and an allowance that has to be spent across the whole file
 * rather than handed out afresh at every level.
 */
describe('importing what is inside a shape', () => {
  const service = (id: string, inside?: unknown) => ({
    id,
    type: 'service',
    x: 0,
    y: 0,
    width: 160,
    height: 60,
    z: 0,
    ...(inside === undefined ? {} : { inside }),
  });

  const room = (nodes: unknown[]) => ({ nodes, edges: [], flows: [] });

  it('keeps a room, and repairs inside it exactly as it would at the top', () => {
    const result = parse({
      ...base,
      nodes: [service('outer', room([{ ...service('inner'), accent: 'chartreuse', x: 10 ** 9 }]))],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inner = result.document.nodes[0]!.inside!.nodes[0]!;
    expect(inner.accent).toBeUndefined();
    expect(inner.x).toBe(LIMITS.maxCoordinate);
  });

  it('drops a room that is empty, unreadable, or on a shape that holds nothing', () => {
    const result = parse({
      ...base,
      nodes: [
        service('a', room([])),
        service('b', 'not an object'),
        { id: 'c', type: 'note', x: 0, y: 0, width: 100, height: 50, z: 0, inside: room([service('x')]) },
      ],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.map((n) => n.inside)).toEqual([undefined, undefined, undefined]);
    expect(result.repairs.join(' ')).toContain('inside');
  });

  it('stops nesting at the depth limit and says so', () => {
    let nested: Record<string, unknown> = service('deepest');
    for (let level = 0; level < LIMITS.maxInsideDepth + 2; level += 1) {
      nested = service(`level-${level}`, room([nested]));
    }
    const result = parse({ ...base, nodes: [nested], edges: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    let depth = 0;
    let cursor = result.document.nodes[0];
    while (cursor?.inside) {
      depth += 1;
      cursor = cursor.inside.nodes[0];
    }
    expect(depth).toBe(LIMITS.maxInsideDepth);
    expect(result.repairs.join(' ')).toContain('nested deeper');
  });

  it('gives a new id to a node that repeats one from another room', () => {
    const result = parse({
      ...base,
      nodes: [service('same'), service('holder', room([service('same')]))],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outer, holder] = result.document.nodes;
    expect(holder!.inside!.nodes[0]!.id).not.toBe(outer!.id);
  });

  it('spends one allowance across the whole file, outermost first', () => {
    // One slot short of the limit once the holder itself is counted.
    const outer = Array.from({ length: LIMITS.maxNodes - 2 }, (_, i) => service(`n${i}`));
    const result = parse({
      ...base,
      nodes: [...outer, service('holder', room([service('deep-a'), service('deep-b')]))],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The overview survives whole; the room only gets what is left of the budget.
    expect(result.document.nodes).toHaveLength(LIMITS.maxNodes - 1);
    expect(result.document.nodes.at(-1)!.inside!.nodes).toHaveLength(1);
  });

  /**
   * A node id is also a path segment, and rooms are named by joining them. An id carrying the
   * character that joins them could name the same room as two other shapes, and be handed the
   * wrong room's contents — so it is reissued, exactly as a duplicate is, and every reference
   * to it moves with it.
   */
  it('reissues a node id that could be mistaken for a path', () => {
    const result = parse({
      ...base,
      nodes: [service('a\u0000b'), service('plain')],
      edges: [{ id: 'e1', source: 'a\u0000b', target: 'plain' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.document.nodes;
    expect(first!.id).not.toContain('\u0000');
    expect(second!.id).toBe('plain');
    // The connector followed the rename rather than being dropped as dangling.
    expect(result.document.edges).toHaveLength(1);
    expect(result.document.edges[0]!.source).toBe(first!.id);
  });

  /**
   * Flows were the one thing a file could hold without limit: fifty a room, and nothing counting
   * the rooms. They come off the same file-wide allowance as shapes and connectors now.
   */
  it('spends the flow allowance across the whole file too', () => {
    const flows = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, title: `Flow ${i}`, steps: [] }));
    const result = parse({
      ...base,
      nodes: [service('holder', { ...room([service('inner')]), flows: flows(10, 'in') })],
      edges: [],
      flows: flows(LIMITS.maxFlows - 2, 'out'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows).toHaveLength(LIMITS.maxFlows - 2);
    // Two left of the file's allowance, so that is all the room gets.
    expect(result.document.nodes[0]!.inside!.flows).toHaveLength(2);
  });

  /**
   * Shapes a hand-written or hostile file can take that the app itself never writes. The bar is
   * the same everywhere: repair what can be repaired, drop only the part that cannot, never
   * throw, and never leave a connector or a flow step pointing at something that was dropped.
   */
  describe('a room shaped in ways the app never writes', () => {
    const cases: [string, unknown][] = [
      ['an array', []],
      ['a number', 7],
      ['null', null],
      ['nodes that are not a list', { nodes: 'lots', edges: [], flows: [] }],
      ['nodes holding nulls', { nodes: [null, undefined, service('ok')], edges: [], flows: [] }],
      ['edges that are not a list', { nodes: [service('ok')], edges: {}, flows: [] }],
      ['flows that are not a list', { nodes: [service('ok')], edges: [], flows: 3 }],
      ['a viewport of nonsense', { nodes: [service('ok')], edges: [], flows: [], viewport: { x: 'far', y: null, zoom: 0 } }],
      ['a level nobody has heard of', { nodes: [service('ok')], edges: [], flows: [], level: 'galaxy' }],
      ['an edge pointing outside the room', { nodes: [service('ok')], edges: [{ id: 'e', source: 'ok', target: 'elsewhere' }], flows: [] }],
      ['a flow step naming a connector that went', { nodes: [service('ok')], edges: [], flows: [{ id: 'f', title: 'F', steps: [{ id: 's', edgeId: 'gone' }] }] }],
      ['a prototype key', { nodes: [service('ok')], edges: [], flows: [], __proto__: { pwned: true } }],
    ];

    it.each(cases)('opens a canvas whose room is %s', (_label, inside) => {
      const result = parse({ ...base, nodes: [service('holder', inside), service('bystander')], edges: [] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The canvas itself always survives whole.
      expect(result.document.nodes).toHaveLength(2);
      expect(({} as Record<string, unknown>).pwned).toBeUndefined();

      const room = result.document.nodes[0]!.inside;
      if (!room) return;
      // Whatever survived is internally consistent: nothing points at something that was dropped.
      const nodeIds = new Set(room.nodes.map((n) => n.id));
      const edgeIds = new Set(room.edges.map((e) => e.id));
      for (const edge of room.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
      for (const flow of room.flows) {
        for (const step of flow.steps) {
          if (step.edgeId) expect(edgeIds.has(step.edgeId)).toBe(true);
        }
      }
      expect(Number.isFinite(room.viewport.x)).toBe(true);
      expect(room.viewport.zoom).toBeGreaterThan(0);
    });

    it('keeps the overview when thousands of shapes each claim a room', () => {
      const many = Array.from({ length: 4000 }, (_, i) => service(`n${i}`, room([service(`deep${i}`)])));
      const result = parse({ ...base, nodes: many, edges: [] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nodes).toHaveLength(4000);
      // Every shape and every room it kept is still inside one file-wide allowance.
      const kept = result.document.nodes.reduce((n, node) => n + 1 + (node.inside?.nodes.length ?? 0), 0);
      expect(kept).toBeLessThanOrEqual(LIMITS.maxNodes);
    });

    it('gives a shape that holds nothing no room, however it was labelled', () => {
      const result = parse({
        ...base,
        nodes: [
          { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 300, z: 0, inside: room([service('x')]) },
          { id: 't', type: 'text', x: 0, y: 0, width: 100, height: 40, z: 0, inside: room([service('y')]) },
        ],
        edges: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nodes.every((n) => n.inside === undefined)).toBe(true);
      expect(result.repairs.join(' ')).toContain('inside');
    });
  });

  /** A room's own truncation must not read as a claim about the whole document. */
  it('says which canvas it cut when a room is the thing that overflowed', () => {
    const outer = Array.from({ length: LIMITS.maxNodes - 2 }, (_, i) => service(`n${i}`));
    const result = parse({
      ...base,
      nodes: [...outer, service('holder', room([service('deep-a'), service('deep-b')]))],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs.join(' ')).toContain('What was inside a shape had 2 nodes; kept the first 1.');
  });
});
