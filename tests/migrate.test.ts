import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/document/validate';
import { CURRENT_VERSION, DRAFT_FORMAT } from '../src/document/types';
import { chooseSides } from '../src/edges/routing';
import { migrateToCurrent } from '../src/document/migrate';

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
        { id: 'a', type: 'note', x: 0, y: 0, width: 100, height: 60 },
        { id: 'b', type: 'note', x: 300, y: 0, width: 100, height: 60 },
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
 * A `version` field can be corrupted (hand edit, a bug in some other tool,
 * bit rot) rather than merely absent. `migrateToCurrent` used to treat any
 * non-integer or out-of-range value as an immediate no-op — relabelling
 * straight to v1 without running a single migration — which would silently
 * misinterpret a genuinely old-shaped document instead of repairing it. The
 * fix clamps the malformed value down to v1 and lets the ordinary migration
 * chain run from there, same as ever.
 */
describe('corrupted or nonsensical version fields', () => {
  /** Same v1-shaped fixture as the legacy-sequence test above, just with a
   *  corrupted `version` in place of the plain `1`. */
  function legacyFixture(version: unknown) {
    return {
      format: DRAFT_FORMAT,
      version,
      metadata: { id: 'd1', title: 'Very old', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'note', x: 0, y: 0, width: 100, height: 60 },
        { id: 'b', type: 'note', x: 300, y: 0, width: 100, height: 60 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sequence: 1 }],
    };
  }

  // Passed as objects, not JSON strings — `JSON.stringify` would turn `NaN`
  // into `null` before it ever reached `migrateToCurrent`, which is a
  // different (already-handled) case; `parseDocument` accepts a raw value
  // just as readily as a JSON string, so this exercises the real value.
  it.each([['NaN', Number.NaN], ['fractional', 1.5], ['zero', 0], ['negative', -3]])(
    'still runs the full migration chain for a %s version, not just relabelling it',
    (_label, version) => {
      const result = parseDocument(legacyFixture(version));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.version).toBe(CURRENT_VERSION);
      // Only present once the v2→v3 anchor-backfill migration has actually
      // run — proves the chain executed rather than being skipped.
      expect(result.document.edges[0]!.sourceAnchor).toBeDefined();
      expect(result.document.edges[0]!.targetAnchor).toBeDefined();
    },
  );
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
        { id: 'a', type: 'note', x: 0, y: 0, width: 100, height: 60 },
        { id: 'b', type: 'note', x: 300, y: 0, width: 100, height: 60 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sequence: 1 }],
    };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
  });
});

/**
 * The v6→v7 migration: v6 still has the `card`/`rounded` node types, which v7
 * removes — there is no blank, semantics-free box primitive anymore. Existing
 * `card`/`rounded` elements (nodes, and attachments folded into a node or
 * edge) retype to `note`, the closest surviving "just hold some text"
 * primitive, keeping every other field untouched so an old diagram keeps
 * showing the same content in the same place, just under a different type.
 */
describe('v6 to v7 migration: Card and rounded removal', () => {
  function v6Fixture(overrides: { nodes?: unknown[]; edges?: unknown[] } = {}) {
    return {
      format: DRAFT_FORMAT,
      version: 6,
      metadata: { id: 'd1', title: 'Legacy', createdAt: 0, updatedAt: 0 },
      nodes: overrides.nodes ?? [],
      edges: overrides.edges ?? [],
      settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
      flows: [],
    };
  }

  it('retypes card and rounded nodes to note, preserving text/position/size/accent', () => {
    const raw = v6Fixture({
      nodes: [
        { id: 'a', type: 'card', x: 10, y: 20, width: 140, height: 70, text: 'Keep me', accent: 'amber' },
        { id: 'b', type: 'rounded', x: 300, y: 0, width: 120, height: 60, text: 'And me' },
      ],
    });
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    const [a, b] = result.document.nodes;
    expect(a).toMatchObject({ type: 'note', x: 10, y: 20, width: 140, height: 70, text: 'Keep me', accent: 'amber' });
    expect(b).toMatchObject({ type: 'note', x: 300, y: 0, width: 120, height: 60, text: 'And me' });
  });

  it('retypes card/rounded attachments folded into a node to note', () => {
    const raw = v6Fixture({
      nodes: [
        {
          id: 'a',
          type: 'service',
          x: 0,
          y: 0,
          attachments: [{ id: 'att1', type: 'card', text: 'Attached detail' }],
        },
      ],
    });
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]!.attachments).toEqual([
      { id: 'att1', type: 'note', text: 'Attached detail', noteKind: 'note' },
    ]);
  });

  it('retypes card/rounded attachments folded into an edge to note', () => {
    const raw = v6Fixture({
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0 },
        { id: 'b', type: 'service', x: 300, y: 0 },
      ],
      edges: [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          directed: true,
          routing: 'smoothstep',
          attachments: [{ id: 'att1', type: 'rounded', text: 'Edge detail' }],
        },
      ],
    });
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0]!.attachments).toEqual([
      { id: 'att1', type: 'note', text: 'Edge detail', noteKind: 'note' },
    ]);
  });

  it('leaves every other node type untouched', () => {
    const raw = v6Fixture({
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, text: 'Untouched' },
        { id: 'b', type: 'group', x: 0, y: 0, boundaryPreset: 'system' },
      ],
    });
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]!.type).toBe('service');
    expect(result.document.nodes[1]!.type).toBe('group');
  });
});

/**
 * The v8→v9 migration: v8 has no concept of a Project at all — same
 * structural-no-op shape as `migrateFlowAccent`/`migrateBackground`. An
 * absent `metadata.projectId` already means Unorganized.
 */
describe('v8 to v9 migration: Projects', () => {
  function v8Fixture(metaOverrides: Record<string, unknown> = {}) {
    return {
      format: DRAFT_FORMAT,
      version: 8,
      metadata: { id: 'd1', title: 'Legacy', createdAt: 0, updatedAt: 0, ...metaOverrides },
      nodes: [{ id: 'a', type: 'service', x: 0, y: 0, width: 120, height: 60 }],
      edges: [],
      settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
      flows: [],
    };
  }

  it('migrates a v8 document to the current version with no project assigned', () => {
    const result = parseDocument(JSON.stringify(v8Fixture()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.metadata.projectId).toBeUndefined();
  });

  it('accepts a valid projectId on a hand-authored v8-shaped-but-v9-aware fixture', () => {
    const result = parseDocument(JSON.stringify(v8Fixture({ projectId: 'p_abc123' })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.metadata.projectId).toBe('p_abc123');
  });
});

describe('v10 to v11 migration: BFF Service kind removal', () => {
  function v10Fixture(overrides: { nodes?: unknown[]; edges?: unknown[] } = {}) {
    return {
      format: DRAFT_FORMAT,
      version: 10,
      metadata: { id: 'd1', title: 'Legacy', createdAt: 0, updatedAt: 0 },
      nodes: overrides.nodes ?? [],
      edges: overrides.edges ?? [],
      settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
      flows: [],
    };
  }

  it('retypes a bff Service to api, preserving label and other properties', () => {
    const raw = v10Fixture({
      nodes: [
        {
          id: 'a',
          type: 'service',
          serviceKind: 'bff',
          x: 10,
          y: 20,
          width: 140,
          height: 70,
          text: 'Web BFF',
          accent: 'teal',
        },
      ],
    });
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.nodes[0]).toMatchObject({
      type: 'service',
      serviceKind: 'api',
      x: 10,
      y: 20,
      width: 140,
      height: 70,
      text: 'Web BFF',
      accent: 'teal',
    });
  });

  it('leaves non-bff services and other node types untouched', () => {
    const raw = v10Fixture({
      nodes: [
        { id: 'a', type: 'service', serviceKind: 'gateway', x: 0, y: 0, text: 'Gateway' },
        { id: 'b', type: 'note', x: 0, y: 0, text: 'A note' },
      ],
    });
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]).toMatchObject({ type: 'service', serviceKind: 'gateway' });
    expect(result.document.nodes[1]).toMatchObject({ type: 'note' });
  });
});

/**
 * Every fixture-based test above already exercises the full v1→current chain incidentally (a gap
 * anywhere in `MIGRATIONS` would make any of them throw "Missing migration..."), but that
 * protection is implicit — tied to those fixtures continuing to exist and continuing to start from
 * v1. This test makes the actual invariant explicit and independent of fixture upkeep: every
 * version from 1 up to `CURRENT_VERSION - 1` has an entry, so bumping `CURRENT_VERSION` without
 * adding the matching migration function fails here directly, with a message that says exactly
 * which version is missing, rather than only surfacing as a fixture test failing for a less
 * obvious reason.
 */
/**
 * v11 → v12 adds `DraftNode.inside`. Nothing on disk had to change for it — a v11 node simply has
 * no inside — but the version did, so that a v11 build refuses the file by name instead of
 * quietly stripping the rooms out of it on the next save.
 */
describe('v11 to v12 migration: a shape can have an inside', () => {
  it('opens a v11 file unchanged, with no rooms invented', () => {
    const result = parseDocument(
      JSON.stringify({
        format: DRAFT_FORMAT,
        version: 11,
        metadata: { id: 'd1', title: 'Lending', createdAt: 1, updatedAt: 2 },
        nodes: [{ id: 'a', type: 'service', x: 0, y: 0, width: 160, height: 60, z: 0, text: 'Platform' }],
        edges: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.nodes[0]!.inside).toBeUndefined();
  });

  it('brings a room through the whole chain from v1', () => {
    const result = parseDocument(
      JSON.stringify({
        format: DRAFT_FORMAT,
        version: 1,
        metadata: { id: 'd1', title: 'Lending', createdAt: 1, updatedAt: 2 },
        nodes: [
          {
            id: 'a',
            type: 'service',
            x: 0,
            y: 0,
            width: 160,
            height: 60,
            z: 0,
            inside: {
              nodes: [{ id: 'b', type: 'component', x: 0, y: 0, width: 160, height: 60, z: 0, text: 'Controller' }],
              edges: [],
              flows: [],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
          },
        ],
        edges: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]!.inside?.nodes[0]?.text).toBe('Controller');
  });
});

describe('migration chain completeness', () => {
  it('has no gap between v1 and the current version', () => {
    const { applied } = migrateToCurrent({ version: 1 });
    const expected = Array.from({ length: CURRENT_VERSION - 1 }, (_, i) => i + 1);
    expect(applied).toEqual(expected);
  });
});

/**
 * The permanent tax `DraftNode.inside` introduced: since v12 a document is a tree of graphs, so a
 * migration that rewrites nodes, edges or flows has to reach every room, not just the top one.
 *
 * This is the thing that makes that rule enforceable rather than advisory. Rather than trusting
 * each migration to remember, it builds one old file whose rooms carry, at every depth, the exact
 * data each graph-touching migration exists to rewrite — and insists that all of it came through.
 */
describe('a migration reaches every room, not just the top one', () => {
  /** One graph carrying a v1 walkthrough, a v6 Card, a v7 reply and a v10 BFF, nested `depth` deep. */
  function graph(depth: number): Record<string, unknown> {
    const inner: Record<string, unknown> = {
      nodes: [
        { id: `bff-${depth}`, type: 'service', serviceKind: 'bff', x: 0, y: 0, width: 160, height: 60, z: 0 },
        { id: `card-${depth}`, type: 'card', x: 300, y: 0, width: 160, height: 60, z: 0, text: 'Note' },
      ],
      edges: [
        {
          id: `e-${depth}`,
          source: `bff-${depth}`,
          target: `card-${depth}`,
          sequence: 1,
          response: 'ok',
        },
      ],
      flows: [],
      ...(depth === 0 ? {} : { viewport: { x: 0, y: 0, zoom: 1 } }),
    };
    if (depth < 3) {
      const owner: Record<string, unknown> = {
        id: `owner-${depth}`,
        type: 'service',
        x: 600,
        y: 0,
        width: 160,
        height: 60,
        z: 0,
        inside: graph(depth + 1),
      };
      (inner.nodes as unknown[]).push(owner);
    }
    return inner;
  }

  const migrated = (() => {
    const result = parseDocument(
      JSON.stringify({
        format: DRAFT_FORMAT,
        version: 1,
        metadata: { id: 'd1', title: 'Deep', createdAt: 1, updatedAt: 2 },
        ...graph(0),
      }),
    );
    if (!result.ok) throw new Error('fixture did not open');
    return result.document;
  })();

  /** The graph at each of the four levels, outermost first. */
  const levels = (() => {
    const out: { nodes: readonly { serviceKind?: string; type: string }[]; edges: readonly { hasResponse?: boolean }[]; flows: readonly unknown[] }[] = [];
    let graphAt: { nodes: readonly typeof migrated.nodes[number][]; edges: readonly typeof migrated.edges[number][]; flows: readonly unknown[] } = migrated;
    for (let depth = 0; depth < 4; depth += 1) {
      out.push(graphAt);
      const owner = graphAt.nodes.find((n) => n.id.startsWith('owner-'));
      if (!owner?.inside) break;
      graphAt = owner.inside;
    }
    return out;
  })();

  it('built a fixture four levels deep', () => {
    expect(levels).toHaveLength(4);
  });

  it.each([0, 1, 2, 3])('turns the BFF at depth %i into an API', (depth) => {
    const bff = levels[depth]!.nodes.find((n) => n.type === 'service' && 'serviceKind' in n && n.serviceKind !== undefined);
    expect(bff?.serviceKind).toBe('api');
  });

  it.each([0, 1, 2, 3])('turns the Card at depth %i into a Note', (depth) => {
    expect(levels[depth]!.nodes.some((n) => n.type === 'card')).toBe(false);
    expect(levels[depth]!.nodes.some((n) => n.type === 'note')).toBe(true);
  });

  it.each([0, 1, 2, 3])('gives the reply at depth %i its line', (depth) => {
    expect(levels[depth]!.edges[0]!.hasResponse).toBe(true);
  });

  it.each([0, 1, 2, 3])('turns the numbered walkthrough at depth %i into a flow', (depth) => {
    expect(levels[depth]!.flows).toHaveLength(1);
  });

  /**
   * `mapGraphs` runs before validation, so it is the one place a hostile file could exhaust the
   * stack before the depth cap ever got a say.
   */
  it('does not recurse into the ground on a file nested past any sane depth', () => {
    let nested: Record<string, unknown> = { nodes: [], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    for (let i = 0; i < 20_000; i += 1) {
      nested = {
        nodes: [{ id: `n${i}`, type: 'service', x: 0, y: 0, width: 160, height: 60, z: 0, inside: nested }],
        edges: [],
        flows: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
    }
    expect(() =>
      migrateToCurrent({
        version: 1,
        metadata: { id: 'd', title: 'Deep', createdAt: 1, updatedAt: 1 },
        ...nested,
      }),
    ).not.toThrow();
  });
});
