/**
 * The single funnel for document-version handling.
 *
 * Nothing else in the codebase may branch on `version`. When the on-disk shape
 * changes, bump `CURRENT_VERSION` in `types.ts` and add one entry here that
 * takes a v(n) shaped object and returns a v(n+1) shaped one.
 */
import { CURRENT_VERSION } from './types';

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * `MIGRATIONS[n]` upgrades a version-`n` document to version `n + 1`.
 * Empty today: version 1 is the first released format.
 */
const MIGRATIONS: Record<number, Migration> = {};

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
