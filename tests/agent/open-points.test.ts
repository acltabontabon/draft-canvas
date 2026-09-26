import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { diffForReview } from '../../src/agent/proposal';
import { addOpenPoint, createOpenPoint } from '../../src/document/openPoints';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

/**
 * Open points through the agent's tools: read back as data, raised and changed only by explicit
 * fields, kept through every unrelated edit — and never inferred from what a label says.
 */

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_openpoints00').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const base = () =>
  build({
    nodes: [
      { id: 'api', type: 'api', label: 'Orders API' },
      { id: 'db', type: 'database', label: 'Orders DB' },
    ],
    relationships: [{ id: 'd', from: 'api', to: 'db' }],
  });

const refusal = (run: () => unknown): AgentError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('open points through update_diagram', () => {
  it('raises a point about existing and newly added things, and reads it back', () => {
    const { file, counts } = applyUpdate(
      base(),
      [],
      [
        {
          op: 'add',
          nodes: [{ id: 'mail', type: 'worker', label: 'Mailer' }],
          openPoints: [{ id: 'op1', kind: 'tentative', context: 'Async?', about: ['d', 'mail'] }],
        },
      ],
      undefined,
    );
    expect(counts.added).toBeGreaterThanOrEqual(2);
    expect(file.openPoints).toEqual([{ id: 'op1', kind: 'tentative', context: 'Async?', targets: [{ kind: 'edge', id: 'd' }, { kind: 'node', id: 'mail' }] }]);
    const read = readDiagram(file, {}, 'rev', 'd_openpoints00') as { openPoints?: unknown[] };
    expect(read.openPoints).toEqual([{ id: 'op1', kind: 'tentative', context: 'Async?', about: ['d', 'mail'] }]);
  });

  it('refuses a point about nothing, an unknown kind, or something that is not there', () => {
    expect(refusal(() => applyUpdate(base(), [], [{ op: 'add', openPoints: [{ kind: 'tentative', about: [] }] }], undefined)).code).toBe('INVALID_INPUT');
    expect(refusal(() => applyUpdate(base(), [], [{ op: 'add', openPoints: [{ kind: 'confident', about: ['api'] }] }], undefined)).code).toBe('INVALID_INPUT');
    expect(refusal(() => applyUpdate(base(), [], [{ op: 'add', openPoints: [{ kind: 'parked', about: ['ghost'] }] }], undefined)).code).toBe('INVALID_REFERENCE');
  });

  it('changes kind, context, resolution and targets by id — explicitly, never by inference', () => {
    const start = addOpenPoint(base(), createOpenPoint('tentative', [{ kind: 'node', id: 'api' }], 'Sync?')!);
    const id = start.openPoints[0]!.id;
    const { file } = applyUpdate(start, [], [{ op: 'update', id, set: { kind: 'awaiting', context: 'Ask the ledger team', about: ['api', 'd'] } }], undefined);
    expect(file.openPoints[0]).toMatchObject({ kind: 'awaiting', context: 'Ask the ledger team', targets: [{ kind: 'node', id: 'api' }, { kind: 'edge', id: 'd' }] });
    const settled = applyUpdate(file, [], [{ op: 'update', id, set: { resolved: true, resolution: 'Agreed on async' } }], undefined).file;
    expect(settled.openPoints[0]).toMatchObject({ resolved: true, resolution: 'Agreed on async' });
    const reopened = applyUpdate(settled, [], [{ op: 'update', id, set: { resolved: false, context: null } }], undefined).file;
    expect(reopened.openPoints[0]!.resolved).toBeUndefined();
    expect(reopened.openPoints[0]!.context).toBeUndefined();
    // Renaming the element it is about says nothing about the point.
    const renamed = applyUpdate(reopened, [], [{ op: 'update', id: 'api', set: { label: 'Orders API (async)' } }], undefined).file;
    expect(renamed.openPoints).toEqual(reopened.openPoints);
  });

  it('removes a point by id, and drops one whose last target is removed', () => {
    const start = addOpenPoint(base(), createOpenPoint('parked', [{ kind: 'node', id: 'db' }])!);
    const id = start.openPoints[0]!.id;
    expect(applyUpdate(start, [], [{ op: 'remove', ids: [id] }], undefined).file.openPoints).toEqual([]);
    expect(applyUpdate(start, [], [{ op: 'remove', ids: ['db'] }], undefined).file.openPoints).toEqual([]);
  });

  it('keeps every point through unrelated edits, and a scoped request may not touch one', () => {
    const start = addOpenPoint(base(), createOpenPoint('awaiting', [{ kind: 'node', id: 'api' }], 'Confirm')!);
    const id = start.openPoints[0]!.id;
    const arranged = applyUpdate(start, [], [{ op: 'add', nodes: [{ id: 'q', type: 'queue', label: 'Orders' }], relationships: [{ id: 'r', from: 'api', to: 'q' }] }, { op: 'arrange' }], undefined).file;
    expect(arranged.openPoints).toEqual(start.openPoints);
    expect(refusal(() => applyUpdate(start, [], [{ op: 'update', id, set: { resolved: true } }], undefined, { nodes: ['api'], edges: [] })).code).toBe('OUT_OF_SCOPE');
    // A proposal's review shows the point's change as its own row — never as an element.
    const diff = diffForReview(start, applyUpdate(start, [], [{ op: 'update', id, set: { resolved: true } }], undefined).file, []);
    expect(diff).toEqual([
      { kind: 'open point', id, change: 'modified', label: 'Awaiting input · Confirm', fields: [{ field: 'resolved', before: undefined, after: 'yes' }] },
    ]);
  });
});
