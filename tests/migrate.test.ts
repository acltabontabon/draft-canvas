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
