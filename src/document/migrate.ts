/**
 * The single funnel for document-version handling.
 *
 * Nothing else in the codebase may branch on `version`. When the on-disk shape
 * changes, bump `CURRENT_VERSION` in `types.ts` and add one entry here that
 * takes a v(n) shaped object and returns a v(n+1) shaped one.
 */
import { createId } from './ids';
import { CURRENT_VERSION } from './types';

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * v1's single, document-wide numbered walkthrough (`edge.sequence`) becomes a
 * single named Flow in v2, so an existing walkthrough keeps working exactly
 * as it looked before — multiple, independently-orderable flows are new, but
 * nothing that already existed is lost. Edges lose their `sequence` field;
 * order now lives entirely in the flow's `steps`.
 */
function migrateSequenceToFlows(doc: Record<string, unknown>): Record<string, unknown> {
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  const sequenced: { id: unknown; sequence: number }[] = [];
  for (const raw of edges) {
    if (!raw || typeof raw !== 'object') continue;
    const edge = raw as Record<string, unknown>;
    if (typeof edge.sequence === 'number' && Number.isFinite(edge.sequence)) {
      sequenced.push({ id: edge.id, sequence: edge.sequence });
    }
  }
  sequenced.sort((a, b) => a.sequence - b.sequence);

  const strippedEdges = edges.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const { sequence: _drop, ...rest } = raw as Record<string, unknown>;
    return rest;
  });

  const existingFlows = Array.isArray(doc.flows) ? doc.flows : [];
  const flows =
    sequenced.length > 0
      ? [
          ...existingFlows,
          {
            id: createId('f'),
            title: 'Walkthrough',
            steps: sequenced.map((entry) => ({ id: createId('fs'), edgeId: entry.id })),
          },
        ]
      : existingFlows;

  return { ...doc, edges: strippedEdges, flows };
}

/**
 * `MIGRATIONS[n]` upgrades a version-`n` document to version `n + 1`.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: migrateSequenceToFlows,
};

export class UnsupportedVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(
      `This file was made with a newer version of Draft Canvas (document format v${version}, this app reads up to v${CURRENT_VERSION}).`,
    );
    this.version = version;
    this.name = 'UnsupportedVersionError';
  }
}

export function migrateToCurrent(raw: Record<string, unknown>): {
  doc: Record<string, unknown>;
  applied: number[];
} {
  const version = typeof raw.version === 'number' ? raw.version : 1;
  if (!Number.isInteger(version) || version < 1) {
    // Treat nonsense as the oldest known format and let the normalizer repair it.
    return { doc: { ...raw, version: 1 }, applied: [] };
  }
  if (version > CURRENT_VERSION) throw new UnsupportedVersionError(version);

  let doc = raw;
  const applied: number[] = [];
  for (let v = version; v < CURRENT_VERSION; v += 1) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(`Missing migration from document format v${v} to v${v + 1}.`);
    }
    doc = migration(doc);
    applied.push(v);
  }
  return { doc: { ...doc, version: CURRENT_VERSION }, applied };
}
