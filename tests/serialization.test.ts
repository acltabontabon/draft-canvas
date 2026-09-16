import { describe, expect, it } from 'vitest';
import { createAttachment, createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, extractFragment, pasteFragment } from '../src/document/operations';
import { addFlow, createFlow } from '../src/document/flow';
import { deserializeDocument, serializeDocument, fileNameFor } from '../src/export/project';
import { CURRENT_VERSION } from '../src/document/types';
import { ARCHITECTURE_STARTERS } from '../src/starters';
import { buildStarter } from '../src/starters/build';

function richDocument() {
  const service = createNode({
    type: 'service',
    x: 40,
    y: 80,
    text: 'Order Service',
    accent: 'teal',
  });
  const queue = createNode({ type: 'queue', x: 380, y: 80, text: 'orders.v1', accent: 'violet' });
  const db = createNode({ type: 'database', x: 40, y: 260, text: 'orders' });
  const code = createNode({
    type: 'code',
    x: 380,
    y: 260,
    width: 420,
    height: 220,
    language: 'json',
    code: '{\n  "accountId": "123",\n  "status": "CANCELLED"\n}',
  });
  const note = createNode({
    type: 'note',
    x: 820,
    y: 80,
    text: 'Why is this retried twice?',
    noteKind: 'question',
  });
  note.attachments = [createAttachment({ type: 'note', text: 'Follow up with the payments team' })];

  const boundary = createNode({ type: 'group', x: 20, y: 40, width: 420, height: 300, text: 'Order domain' });
  db.parentId = boundary.id;

  const published = createEdge({
    source: service.id,
    target: queue.id,
    label: 'ORDER_CREATED',
  });
  const persisted = createEdge({ source: service.id, target: db.id });
  persisted.details = { language: 'sql', code: 'select * from orders where id = ?' };

  let doc = addNodes(createDocument('Payment Flow'), [service, queue, db, code, note, boundary]);
  doc = addEdges(doc, [published, persisted]);
  const flow = createFlow({ title: 'Happy path' });
  flow.steps = [
    { id: 'fs1', edgeId: published.id, caption: 'Publish the event' },
    { id: 'fs2', edgeId: persisted.id },
  ];
  doc = addFlow(doc, flow);
  return { ...doc, viewport: { x: -120, y: 40, zoom: 1.25 } };
}

describe('.draftcanvas round trip', () => {
  it('restores an identical, fully editable document', () => {
    const original = richDocument();
    const result = deserializeDocument(serializeDocument(original));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.repairs).toEqual([]);
    expect(result.document.metadata.title).toBe('Payment Flow');
    expect(result.document.metadata.id).toBe(original.metadata.id);
    expect(result.document.nodes).toEqual(original.nodes);
    expect(result.document.edges).toEqual(original.edges);
    expect(result.document.flows).toEqual(original.flows);
    expect(result.document.viewport).toEqual(original.viewport);
    expect(result.document.settings).toEqual(original.settings);
  });

  it('carries a manual routing override through the file format', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0 });
    const doc = addEdges(addNodes(createDocument('Routing'), [a, b]), [
      createEdge({ source: a.id, target: b.id, routeMode: 'direct' }),
    ]);
    const result = deserializeDocument(serializeDocument(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Absent means Smart Routing, so silently dropping this on save would
    // hand a connector the user took control of back to the router.
    expect(result.document.edges[0]!.routeMode).toBe('direct');
  });

  it('is byte-stable across repeated writes', () => {
    const doc = richDocument();
    expect(serializeDocument(doc)).toBe(serializeDocument(doc));
  });

  it('survives a second round trip unchanged', () => {
    const once = deserializeDocument(serializeDocument(richDocument()));
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = deserializeDocument(serializeDocument(once.document));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.document).toEqual(once.document);
  });

  it('preserves code, language and connector details exactly', () => {
    const result = deserializeDocument(serializeDocument(richDocument()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const code = result.document.nodes.find((node) => node.type === 'code')!;
    expect(code.language).toBe('json');
    expect(code.code).toContain('"status": "CANCELLED"');

    const detailed = result.document.edges.find((edge) => edge.details)!;
    expect(detailed.details).toEqual({
      language: 'sql',
      code: 'select * from orders where id = ?',
    });
  });

  // A starter is only ever ordinary document content — nothing about it is a new kind of thing to
  // persist. The round trip is what proves that: nested boundaries, `parentId`, inferred semantics
  // and authored anchors all have to come back exactly as they went in.
  it.each(ARCHITECTURE_STARTERS.map((starter) => [starter.name, starter] as const))(
    'round-trips a canvas built from the %s starter',
    (_label, starter) => {
      const { nodes, edges } = buildStarter(starter, { x: -120, y: -80 });
      const document = addEdges(addNodes(createDocument(starter.name), nodes), edges);

      const result = deserializeDocument(serializeDocument(document));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.repairs).toEqual([]);
      expect(result.document.nodes).toEqual(nodes);
      expect(result.document.edges).toEqual(edges);
      // Containment survives, including the modular monolith's boundary inside a boundary.
      const byId = new Map(result.document.nodes.map((node) => [node.id, node]));
      for (const node of result.document.nodes) {
        if (!node.parentId) continue;
        expect(byId.get(node.parentId)?.type).toBe('group');
      }
    },
  );

  it('writes the current schema version', () => {
    expect(JSON.parse(serializeDocument(createDocument())).version).toBe(CURRENT_VERSION);
  });

  it('carries what is inside a shape through a full round trip', () => {
    const inner = createNode({ type: 'component', x: 20, y: 30, text: 'Loan Controller' });
    const store = createNode({ type: 'database', x: 220, y: 30, text: 'Loans' });
    const link = createEdge({ source: inner.id, target: store.id, label: 'reads' });
    const flow = { ...createFlow({ title: 'Apply for a loan' }), steps: [{ id: 'fs_1', edgeId: link.id }] };
    const platform = {
      ...createNode({ type: 'service', x: 0, y: 0, text: 'Lending Platform' }),
      inside: {
        nodes: [inner, store],
        edges: [link],
        flows: [flow],
        viewport: { x: 12, y: 34, zoom: 1.25 },
      },
    };
    const document = addNodes(createDocument('Lending'), [platform]);

    const result = deserializeDocument(serializeDocument(document));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    expect(result.document.nodes[0]!.inside).toEqual(platform.inside);
  });

  it('leaves a canvas nobody looked inside byte-identical', () => {
    const document = addNodes(createDocument('Flat'), [createNode({ type: 'service', x: 0, y: 0 })]);
    const text = serializeDocument(document);
    expect(text).not.toContain('"inside"');

    const result = deserializeDocument(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serializeDocument(result.document)).toBe(text);
  });

  it('derives a safe file name from the title', () => {
    expect(fileNameFor('Payment Flow / v2')).toBe('payment-flow-v2.draftcanvas');
    expect(fileNameFor('   ')).toBe('draft-canvas.draftcanvas');
    expect(fileNameFor('Diagram', '.svg')).toBe('diagram.svg');
    expect(fileNameFor('Café résumé')).toBe('café-résumé.draftcanvas');
    expect(fileNameFor('決済フロー', '.png')).toBe('決済フロー.png');
    expect(fileNameFor('a\\b:c*d?"e<f>g|h')).toBe('a-b-c-d-e-f-g-h.draftcanvas');
  });
});

/**
 * A round trip has to be a fixed point, whatever the file holds.
 *
 * Two hand-built fixtures prove the shapes someone thought of. This generates nested documents
 * instead and insists that writing one out and reading it back changes nothing — which is the
 * check that would have caught a room quietly losing its level on the way through.
 */
describe('writing a nested canvas out and reading it back', () => {
  /** A tiny deterministic PRNG, so a failure is always the same failure. */
  function rng(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return state / 4_294_967_296;
    };
  }

  const KINDS = ['service', 'database', 'queue', 'component', 'actor', 'note'] as const;
  const LEVELS = [undefined, 'context', 'container', 'component', 'none'] as const;

  function graph(next: () => number, depth: number, tag: string) {
    const count = 1 + Math.floor(next() * 3);
    const nodes = Array.from({ length: count }, (_, i) =>
      createNode({
        type: KINDS[Math.floor(next() * KINDS.length)]!,
        x: Math.floor(next() * 800),
        y: Math.floor(next() * 600),
        text: `${tag}-${i}`,
      }),
    );
    const edges = nodes.length > 1 ? [createEdge({ source: nodes[0]!.id, target: nodes[1]!.id, label: `${tag} link` })] : [];
    const flows = edges.length > 0 ? [addFlowStep(createFlow({ title: `${tag} flow` }), edges[0]!.id)] : [];

    // Only the kinds that may hold one, so nothing is dropped as a repair rather than a round trip.
    if (depth < 3) {
      for (const node of nodes) {
        if (node.type !== 'service' && node.type !== 'component') continue;
        if (next() < 0.5) continue;
        const inner = graph(next, depth + 1, `${tag}${depth}`);
        node.inside = {
          nodes: inner.nodes,
          edges: inner.edges,
          flows: inner.flows,
          viewport: { x: Math.floor(next() * 200), y: Math.floor(next() * 200), zoom: 1 },
          ...(inner.level === undefined ? {} : { level: inner.level }),
        };
      }
    }
    const level = LEVELS[Math.floor(next() * LEVELS.length)];
    return { nodes, edges, flows, ...(level === undefined ? {} : { level }) };
  }

  function addFlowStep(flow: ReturnType<typeof createFlow>, edgeId: string) {
    return { ...flow, steps: [{ id: `fs_${edgeId}`, edgeId }] };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => [seed] as const))(
    'is a fixed point for a generated canvas (seed %i)',
    (seed) => {
      const next = rng(seed);
      const built = graph(next, 0, 'n');
      const document = { ...createDocument('Generated'), ...built };

      const once = deserializeDocument(serializeDocument(document));
      expect(once.ok).toBe(true);
      if (!once.ok) return;
      expect(once.repairs).toEqual([]);

      const twice = deserializeDocument(serializeDocument(once.document));
      expect(twice.ok).toBe(true);
      if (!twice.ok) return;
      // Reading what was written changes nothing the second time either.
      expect(serializeDocument(twice.document)).toBe(serializeDocument(once.document));
      expect(twice.document.nodes).toEqual(once.document.nodes);
    },
  );

  /**
   * Ids are the only thing a copy may change. Anything else it changes is data loss, and the one
   * that escaped review was a room's own level.
   */
  it.each([1, 2, 3, 4, 5].map((seed) => [seed] as const))(
    'changes nothing but ids when a shape with rooms is duplicated (seed %i)',
    (seed) => {
      const next = rng(seed);
      const built = graph(next, 1, 'c');
      const owner = createNode({ type: 'service', x: 0, y: 0, text: 'Owner' });
      owner.inside = {
        nodes: built.nodes,
        edges: built.edges,
        flows: built.flows,
        viewport: { x: 10, y: 20, zoom: 1 },
        ...(built.level === undefined ? {} : { level: built.level }),
      };

      const document = addNodes(createDocument('Copying'), [owner]);
      const pasted = pasteFragment(document, extractFragment(document, [owner.id]), { x: 40, y: 40 });
      expect(pasted.truncated).toBe(false);
      const copy = pasted.doc.nodes.find((n) => n.id !== owner.id)!;

      const stripIds = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(stripIds);
        if (!value || typeof value !== 'object') return value;
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
          if (key === 'id' || key === 'parentId' || key === 'source' || key === 'target') continue;
          if (key === 'edgeId' || key === 'extraEdgeIds' || key === 'extraNodeIds') continue;
          // Paste offsets the copy; the room inside it is untouched.
          if (key === 'x' || key === 'y') continue;
          out[key] = stripIds(inner);
        }
        return out;
      };

      expect(stripIds(copy.inside)).toEqual(stripIds(owner.inside));
    },
  );
});
