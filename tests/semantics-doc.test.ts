import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MATRIX, type NodeCategory } from '../src/document/connectorSemantics';

/**
 * `docs/reference/semantics.md`'s capability-matrix table is a copy of `MATRIX`, and a copy drifts.
 * The continuation tables below it are already checked against the rules; this holds the matrix
 * table to the same standard: one row per matrix key, in the matrix's own order, the relations in
 * the order the inspector lists them, the default the inspector picks. The Notes column is prose
 * and is the doc's own.
 */
const NAMES: Record<NodeCategory, string> = {
  actor: 'Actor',
  service: 'Service',
  external: 'External',
  worker: 'Worker',
  scheduler: 'Scheduler',
  gateway: 'Gateway',
  component: 'Component',
  port: 'Port',
  database: 'Database',
  cache: 'Cache',
  fileSystem: 'File System',
  objectStorage: 'Object Storage',
  searchIndex: 'Search Index',
  queue: 'Queue',
  topic: 'Topic',
  stream: 'Stream',
  junction: 'Junction',
  deadLetter: 'Dead-letter queue',
  generic: 'Generic',
};

describe('docs/reference/semantics.md capability-matrix table', () => {
  const doc = readFileSync(resolve(__dirname, '../docs/reference/semantics.md'), 'utf8');
  // Only the matrix section: the captions and continuation tables further down name pairs too.
  const section = doc.split('## The capability matrix')[1]!.split('\n## ')[0]!;
  const rows = section
    .split('\n')
    .filter((line) => /^\| .+ → .+ \|/.test(line) && !line.startsWith('| Source'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map(([, pair, relations, fallback]) => [pair, relations, fallback]);

  it('lists exactly the matrix rows, in order, with their relations and default', () => {
    const expected = Object.entries(MATRIX).map(([key, cap]) => {
      const [source, target] = key.split('>') as [NodeCategory, NodeCategory];
      return [`${NAMES[source]} → ${NAMES[target]}`, cap.relations.join(', '), cap.defaultRelation ?? '*(none)*'];
    });
    expect(rows).toEqual(expected);
  });
});
