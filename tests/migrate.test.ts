import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/document/validate';
import { CURRENT_VERSION, DRAFT_FORMAT } from '../src/document/types';
import { chooseSides } from '../src/edges/routing';

/**
 * The v2→v3 migration: existing documents have no concept of a connector
 * anchor at all, since it didn't exist yet. Backfilling one from the
 * nearest-side heuristic that already ran live keeps a migrated document's
 * on-screen appearance byte-identical to before migration, and — per the
 * document's own single-source-of-truth version gate — computes it exactly
 * once rather than re-deriving it on every future load.
 */
describe('v2 to v3 migration: connector anchors', () => {
  function v2Fixture(edgeOverrides: Record<string, unknown> = {}) {
    return {
      format: DRAFT_FORMAT,
      version: 2,
      metadata: { id: 'd1', title: 'Legacy', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 },
        { id: 'b', type: 'database', x: 400, y: 0, width: 120, height: 60 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', ...edgeOverrides }],
      flows: [],
    };
  }

  it('migrates all the way to the current version, not just to v3', () => {
    const result = parseDocument(JSON.stringify(v2Fixture()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
  });

  it('backfills an anchor matching the live chooseSides heuristic for the same geometry', () => {
    const result = parseDocument(JSON.stringify(v2Fixture()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const edge = result.document.edges[0]!;
    const expected = chooseSides(
      { x: 0, y: 0, width: 120, height: 60 },
      { x: 400, y: 0, width: 120, height: 60 },
    );
    expect(edge.sourceAnchor).toEqual({ side: expected.source, offset: 0.5 });
    expect(edge.targetAnchor).toEqual({ side: expected.target, offset: 0.5 });
  });

  it('backfills correctly for a vertically-stacked pair too', () => {
    const raw = v2Fixture();
    raw.nodes = [
      { id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 },
      { id: 'b', type: 'database', x: 0, y: 400, width: 120, height: 60 },
    ];
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
    expect(result.document.edges[0]!.targetAnchor).toEqual({ side: 'top', offset: 0.5 });
  });

  it('leaves a dangling edge alone rather than crashing — validation drops it as it always has', () => {
    const raw = v2Fixture({ target: 'missing-node' });
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges).toHaveLength(0);
  });

  it('is idempotent: a v3 document with anchors already set is not touched', () => {
    const raw = {
      format: DRAFT_FORMAT,
      version: CURRENT_VERSION,
      metadata: { id: 'd1', title: 'Current', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 },
        { id: 'b', type: 'database', x: 400, y: 0, width: 120, height: 60 },
      ],
      edges: [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          // Deliberately the opposite of what chooseSides would pick, to
          // prove a real v3 file's explicit anchor is preserved verbatim,
          // not silently re-derived on every load.
          sourceAnchor: { side: 'top', offset: 0.3 },
          targetAnchor: { side: 'bottom', offset: 0.7 },
        },
      ],
      flows: [],
    };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.sourceAnchor).toEqual({ side: 'top', offset: 0.3 });
    expect(result.document.edges[0]!.targetAnchor).toEqual({ side: 'bottom', offset: 0.7 });
  });

  it('reports the migration as a repair, so the UI can tell the user what happened', () => {
    const result = parseDocument(JSON.stringify(v2Fixture()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs.some((r) => r.toLowerCase().includes('upgraded'))).toBe(true);
  });

  it('a v1 document with legacy sequence numbers migrates through v2 and gets anchors too', () => {
    const raw = {
      format: DRAFT_FORMAT,
      version: 1,
      metadata: { id: 'd1', title: 'Very old', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'card', x: 0, y: 0, width: 100, height: 60 },
        { id: 'b', type: 'card', x: 300, y: 0, width: 100, height: 60 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sequence: 1 }],
    };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.edges[0]!.sourceAnchor).toBeDefined();
    expect(result.document.edges[0]!.targetAnchor).toBeDefined();
  });
});

/**
 * The v3→v4 migration: v3 has no concept of a flow accent at all, so there is
 * nothing to backfill — the migration is a structural no-op. Its only job is
 * to exist as an explicit `MIGRATIONS` entry so the version funnel does not
 * throw "missing migration" for a v3 document, and so a v3 flow keeps loading
 * with no accent, rendering exactly as it always did.
 */
describe('v3 to v4 migration: flow accent', () => {
  function v3Fixture(flowOverrides: Record<string, unknown> = {}) {
    return {
      format: DRAFT_FORMAT,
      version: 3,
      metadata: { id: 'd1', title: 'Legacy', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 },
        { id: 'b', type: 'database', x: 400, y: 0, width: 120, height: 60 },
      ],
      edges: [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          sourceAnchor: { side: 'right', offset: 0.5 },
          targetAnchor: { side: 'left', offset: 0.5 },
        },
      ],
      flows: [{ id: 'f1', title: 'Checkout', steps: [{ id: 's1', edgeId: 'e1' }], ...flowOverrides }],
    };
  }

  it('migrates a v3 flow to the current version, unchanged except for version and a missing accent', () => {
    const result = parseDocument(JSON.stringify(v3Fixture()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.flows).toHaveLength(1);
    expect(result.document.flows[0]!.title).toBe('Checkout');
    expect(result.document.flows[0]!.steps).toEqual([{ id: 's1', edgeId: 'e1' }]);
    expect(result.document.flows[0]!.accent).toBeUndefined();
  });

  it('accepts a valid accent on a hand-authored v3-shaped-but-v4-aware fixture', () => {
    const result = parseDocument(JSON.stringify(v3Fixture({ accent: 'violet' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows[0]!.accent).toBe('violet');
  });

  it('drops an invalid accent rather than coercing it, same discipline as node/edge accents', () => {
    const result = parseDocument(JSON.stringify(v3Fixture({ accent: 'not-a-real-colour' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows[0]!.accent).toBeUndefined();
  });
});

/**
 * The v4→v5 migration: v4 has no concept of a canvas background at all, so
 * there is nothing to backfill — a structural no-op, same shape as
 * `migrateFlowAccent`. `normalizeDocument` gives the migrated document a
 * clean, disabled default background block.
 */
describe('v4 to v5 migration: canvas background', () => {
  function v4Fixture() {
    return {
      format: DRAFT_FORMAT,
      version: 4,
      metadata: { id: 'd1', title: 'Legacy', createdAt: 0, updatedAt: 0 },
      nodes: [{ id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 }],
      edges: [],
      settings: { showSequence: true, grid: 'dots' },
      flows: [],
    };
  }

  it('migrates a v4 document to the current version with a clean default background', () => {
    const result = parseDocument(JSON.stringify(v4Fixture()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.settings.background).toEqual({
      enabled: false,
      fit: 'cover',
      dim: 0.55,
      blur: 0,
    });
  });
});

/**
 * The v5→v6 migration: v5 has no concept of a request/response connector at
 * all, so there is nothing to backfill — a structural no-op, same shape as
 * `migrateFlowAccent`/`migrateBackground`.
 */
describe('v5 to v6 migration: request/response connectors', () => {
  function v5Fixture(edgeOverrides: Record<string, unknown> = {}) {
    return {
      format: DRAFT_FORMAT,
      version: 5,
      metadata: { id: 'd1', title: 'Legacy', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 },
        { id: 'b', type: 'service', x: 400, y: 0, width: 120, height: 60 },
      ],
      edges: [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          sourceAnchor: { side: 'right', offset: 0.5 },
          targetAnchor: { side: 'left', offset: 0.5 },
          ...edgeOverrides,
        },
      ],
      settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
      flows: [],
    };
  }

  it('migrates a v5 document to the current version unchanged apart from version', () => {
    const result = parseDocument(JSON.stringify(v5Fixture()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.edges[0]!.response).toBeUndefined();
  });

  it('accepts a valid response on a hand-authored v5-shaped-but-v6-aware fixture', () => {
    const result = parseDocument(JSON.stringify(v5Fixture({ response: '200 Customer' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.response).toBe('200 Customer');
  });

  it('drops an invalid (non-string) response rather than coercing it', () => {
    const result = parseDocument(JSON.stringify(v5Fixture({ response: 42 })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.response).toBeUndefined();
  });

  it('drops a whitespace-only response, same discipline as condition', () => {
    const result = parseDocument(JSON.stringify(v5Fixture({ response: '   ' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.response).toBeUndefined();
  });

  it('a v1 document with legacy sequence numbers still migrates all the way to the current version', () => {
    const raw = {
      format: DRAFT_FORMAT,
      version: 1,
      metadata: { id: 'd1', title: 'Very old', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'card', x: 0, y: 0, width: 100, height: 60 },
        { id: 'b', type: 'card', x: 300, y: 0, width: 100, height: 60 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sequence: 1 }],
    };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
  });
});
