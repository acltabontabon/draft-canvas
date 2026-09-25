import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { diffForReview, looksAlreadyApplied, preconditionConflicts, prepareProposal } from '../../src/agent/proposal';
import { createNode } from '../../src/document/factory';
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

  it('refuses a duplicate id at submit time, the same as update_diagram would (DUPLICATE_ID)', () => {
    // `submit_proposal`'s docs claim its ops are "validated exactly as update_diagram would" — this
    // is that claim, exercised through `prepareProposal` itself, not just the shared `applyUpdate`
    // engine underneath it (which is what the Case B tests below exercise for a different purpose).
    const file = base();
    try {
      prepareProposal(file, [], [{ op: 'add', nodes: [{ id: 'api', type: 'service', label: 'Clash' }] }], undefined, undefined);
      expect.unreachable('expected a DUPLICATE_ID AgentError');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe('DUPLICATE_ID');
    }
  });

  it('accepts a layout.viewport, the same as update_diagram would', () => {
    // `submit_proposal`'s declared schema once excluded `viewport` (a hand-duplicated, narrower
    // copy of `update_diagram`'s layout object) even though this shared engine always accepted it —
    // this is the runtime half of that fix; `tests/agent/schema.test.ts` pins the schema itself.
    const file = base();
    expect(() => prepareProposal(file, [], [{ op: 'update', id: 'api', set: { label: 'Renamed' } }], { viewport: [1600, 900] }, undefined)).not.toThrow();
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

describe('looksAlreadyApplied (crash-recovery Case B)', () => {
  const addOps = [{ op: 'add', nodes: [{ id: 'cache', type: 'redis', label: 'Cache' }] }];
  const matchingLive = { nodes: [createNode({ id: 'cache', type: 'database', x: 0, y: 0, text: 'Cache' })], edges: [] };

  it('is true when every conflicting id is one this proposal would create, and the live content matches', () => {
    expect(looksAlreadyApplied(addOps, ['cache'], matchingLive)).toBe(true);
  });

  it('is false when a conflicting id is not one of this proposal\'s own — genuinely ambiguous (Case C)', () => {
    expect(looksAlreadyApplied(addOps, ['cache', 'somethingElse'], matchingLive)).toBe(false);
    expect(looksAlreadyApplied(addOps, ['somethingElse'], matchingLive)).toBe(false);
  });

  it('is false with no conflicting ids, or no live view, at all (an ordinary, non-duplicate-id failure)', () => {
    expect(looksAlreadyApplied(addOps, undefined, matchingLive)).toBe(false);
    expect(looksAlreadyApplied(addOps, [], matchingLive)).toBe(false);
    expect(looksAlreadyApplied(addOps, ['cache'], undefined)).toBe(false);
  });

  it('is false when the id collides but the live label does not match — a coincidence, not this proposal (regression: false Case B)', () => {
    // Same id, but a different label — something else entirely made this, or a *different* attempt
    // at "cache" landed. Reporting this as already applied would silently discard whatever this
    // proposal actually intended.
    const unrelatedLive = { nodes: [createNode({ id: 'cache', type: 'database', x: 0, y: 0, text: 'Someone else’s cache' })], edges: [] };
    expect(looksAlreadyApplied(addOps, ['cache'], unrelatedLive)).toBe(false);
  });

  it('checks a group id collision by label, since a group has no type to compare', () => {
    const groupOps = [{ op: 'add', groups: [{ id: 'g1', label: 'Team' }] }];
    const groupLive = { nodes: [createNode({ id: 'g1', type: 'group', x: 0, y: 0, text: 'Team' })], edges: [] };
    expect(looksAlreadyApplied(groupOps, ['g1'], groupLive)).toBe(true);
    const mismatchedGroupLive = { nodes: [createNode({ id: 'g1', type: 'group', x: 0, y: 0, text: 'A different team' })], edges: [] };
    expect(looksAlreadyApplied(groupOps, ['g1'], mismatchedGroupLive)).toBe(false);
  });

  it('end to end: re-running a proposal whose add already landed throws with exactly its own id in conflictingIds, and the live content matches', () => {
    const file = base();
    const ops = [{ op: 'add', nodes: [{ id: 'cache', type: 'redis', label: 'Cache' }] }];
    // Simulate the crash: the add already committed to the live document...
    const { file: alreadyThere } = applyUpdate(file, [], ops, undefined, undefined);
    // ...but the proposal, replayed against that same document, naturally collides on its own id.
    try {
      applyUpdate(alreadyThere, [], ops, undefined, undefined);
      expect.unreachable('expected a DUPLICATE_ID AgentError');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      const conflictingIds = (error as AgentError).details?.conflictingIds;
      expect(conflictingIds).toEqual(['cache']);
      expect(looksAlreadyApplied(ops, conflictingIds as string[], alreadyThere)).toBe(true);
    }
  });

  it('end to end: a coincidental id collision from something else entirely is never mistaken for this proposal', () => {
    const file = base();
    const ops = [{ op: 'add', nodes: [{ id: 'cache', type: 'redis', label: 'Cache' }] }];
    // This proposal's own add never landed — a *different* node happens to have grabbed the same id.
    const { file: unrelated } = applyUpdate(file, [], [{ op: 'add', nodes: [{ id: 'cache', type: 'worker', label: 'Unrelated worker' }] }], undefined, undefined);
    try {
      applyUpdate(unrelated, [], ops, undefined, undefined);
      expect.unreachable('expected a DUPLICATE_ID AgentError');
    } catch (error) {
      const conflictingIds = (error as AgentError).details?.conflictingIds;
      expect(looksAlreadyApplied(ops, conflictingIds as string[], unrelated)).toBe(false);
    }
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
