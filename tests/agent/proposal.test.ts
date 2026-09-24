import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { diffForReview, preconditionConflicts, prepareProposal } from '../../src/agent/proposal';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_proptest001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const base = () =>
  build({
    nodes: [
      { id: 'api', type: 'api', label: 'Orders API' },
      { id: 'db', type: 'database', label: 'Orders DB' },
    ],
    relationships: [{ id: 'ud', from: 'api', to: 'db', label: 'Reads' }],
  });

describe('prepareProposal', () => {
  it('computes counts and never mutates the input document', () => {
    const file = base();
    const { counts, preconditions } = prepareProposal(file, [], [{ op: 'update', id: 'api', set: { label: 'Renamed' } }], undefined, undefined);
    expect(counts.updated).toBe(1);
    // The before-value in preconditions is the ORIGINAL label, not the proposed one.
    expect(preconditions.nodes.api).toMatchObject({ label: 'Orders API', type: 'service' });
    expect(file.nodes.find((n) => n.id === 'api')?.text).toBe('Orders API');
  });

  it('captures edge preconditions for an update targeting a relationship', () => {
    const file = base();
    const { preconditions } = prepareProposal(file, [], [{ op: 'update', id: 'ud', set: { label: 'Reads heavily' } }], undefined, undefined);
    expect(preconditions.edges.ud).toMatchObject({ from: 'api', to: 'db', label: 'Reads' });
  });

  it('refuses invalid ops at submit time, the same as update_diagram would', () => {
    const file = base();
    expect(() => prepareProposal(file, [], [{ op: 'update', id: 'nope', set: { label: 'x' } }], undefined, undefined)).toThrow(AgentError);
  });
});

describe('preconditionConflicts', () => {
  it('reports no conflict when nothing referenced has changed', () => {
    const file = base();
    const { preconditions } = prepareProposal(file, [], [{ op: 'update', id: 'api', set: { label: 'Renamed' } }], undefined, undefined);
    expect(preconditionConflicts(file, [], preconditions)).toEqual([]);
  });

  it('reports a conflict when the referenced node changed since the snapshot', () => {
    const file = base();
    const { preconditions } = prepareProposal(file, [], [{ op: 'update', id: 'api', set: { label: 'Renamed' } }], undefined, undefined);
    // Someone else changed 'api' after the proposal captured its precondition.
    const drifted = { ...file, nodes: file.nodes.map((n) => (n.id === 'api' ? { ...n, text: 'Something else' } : n)) };
    const conflicts = preconditionConflicts(drifted, [], preconditions);
    expect(conflicts).toEqual([expect.objectContaining({ id: 'api', kind: 'node' })]);
  });

  it('reports a conflict when the referenced element was deleted since the snapshot', () => {
    const file = base();
    const { preconditions } = prepareProposal(file, [], [{ op: 'update', id: 'db', set: { label: 'Renamed' } }], undefined, undefined);
    const withoutDb = { ...file, nodes: file.nodes.filter((n) => n.id !== 'db') };
    const conflicts = preconditionConflicts(withoutDb, [], preconditions);
    expect(conflicts).toEqual([expect.objectContaining({ id: 'db', now: null })]);
  });

  it('does not flag unrelated document drift as a conflict', () => {
    const file = base();
    const { preconditions } = prepareProposal(file, [], [{ op: 'update', id: 'api', set: { label: 'Renamed' } }], undefined, undefined);
    // A change to an id the proposal never referenced is staleness, not a conflict.
    const unrelatedEdit = { ...file, nodes: file.nodes.map((n) => (n.id === 'db' ? { ...n, text: 'Something else' } : n)) };
    expect(preconditionConflicts(unrelatedEdit, [], preconditions)).toEqual([]);
  });
});

describe('diffForReview', () => {
  it('distinguishes added, modified and removed elements and relationships', () => {
    const file = build({
      nodes: [
        { id: 'api', type: 'api', label: 'Orders API' },
        { id: 'db', type: 'database', label: 'Orders DB' },
        { id: 'worker', type: 'worker', label: 'Untouched worker' },
      ],
      relationships: [
        { id: 'ud', from: 'api', to: 'db', label: 'Reads' },
        { id: 'uw', from: 'api', to: 'worker', label: 'Untouched relationship' },
      ],
    });
    const { file: next } = applyUpdate(
      file,
      [],
      [
        { op: 'update', id: 'api', set: { label: 'Renamed' } },
        { op: 'remove', ids: ['db'] },
        { op: 'add', nodes: [{ id: 'cache', type: 'redis', label: 'Cache' }], relationships: [{ id: 'ac', from: 'api', to: 'cache', label: 'Reads' }] },
      ],
      undefined,
      undefined,
    );
    const rows = diffForReview(file, next, []);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('api')).toMatchObject({ change: 'modified', fields: [{ field: 'label', before: 'Orders API', after: 'Renamed' }] });
    expect(byId.get('db')).toMatchObject({ change: 'removed' });
    expect(byId.get('cache')).toMatchObject({ change: 'added' });
    expect(byId.get('ac')).toMatchObject({ change: 'added' });
    // 'ud' cascades away with 'db' — that's a real removal, correctly reported, not something to hide.
    expect(byId.get('ud')).toMatchObject({ change: 'removed' });
    // Genuinely untouched elements never appear in the diff at all.
    expect(byId.has('worker')).toBe(false);
    expect(byId.has('uw')).toBe(false);
  });
});
