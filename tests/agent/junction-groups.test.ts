import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { validateToolInput } from '../../src/agent/contract';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { diffForReview, prepareProposal } from '../../src/agent/proposal';
import { readEdit, readLookup } from '../../src/agent/read';
import { renamePatch } from '../../src/agent/rename';
import { TOOLS } from '../../src/agent/schema';
import type { DraftDocument } from '../../src/document/types';
import { deserializeDocument } from '../../src/export/project';
import { membersOf } from '../../src/junctions/groups';

/**
 * A linked junction group reads as one label, whoever edits it: what an agent's requests do to a
 * group spread across views, and what it is told about it. The editor's own rules, for edits that
 * arrive as data one junction at a time.
 */

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'Payments', ...raw }, 'd_junctiongroups').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const refusal = (run: () => unknown): AgentError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const said = (error: AgentError) => `${error.message} ${JSON.stringify(error.details ?? {})}`;

/** A hand-off drawn at the top level and continued inside Orders, plus an unrelated "A" elsewhere. */
const spread = () =>
  build({
    nodes: [
      { id: 'checkout', type: 'service', label: 'Checkout' },
      { id: 'out', type: 'junction', label: 'A', link: 'handoff' },
      { id: 'other', type: 'junction', label: 'A', link: 'refunds' },
      {
        id: 'orders',
        type: 'service',
        label: 'Orders',
        inside: {
          nodes: [
            { id: 'in', type: 'junction', label: 'A', link: 'handoff' },
            { id: 'rules', type: 'component', label: 'Rules' },
          ],
          relationships: [{ id: 'enters', from: 'in', to: 'rules' }],
        },
      },
    ],
    relationships: [{ id: 'leaves', from: 'checkout', to: 'out' }],
  });

const labels = (file: DraftDocument, link: string) => membersOf(file, link).map((member) => [member.node.id, member.node.text]);

describe('one request, one label per group', () => {
  it('refuses a create that labels the junctions of one link differently, across views too', () => {
    const error = refusal(() =>
      build({
        nodes: [
          { id: 'out', type: 'junction', label: 'A', link: 'handoff' },
          { id: 'orders', type: 'service', label: 'Orders', inside: { nodes: [{ id: 'in', type: 'junction', label: 'B', link: 'handoff' }, { id: 'c', type: 'component', label: 'Rules' }] } },
        ],
      }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(said(error)).toMatch(/junctions with link "handoff" are one point and read as one label: \/nodes\/0 says "A", this one "B"/);
    // The same label twice, and two groups that happen to read the same, are fine.
    expect(() => spread()).not.toThrow();
  });

  it('refuses an add that labels one new group two ways', () => {
    const error = refusal(() =>
      applyUpdate(spread(), [], [{ op: 'add', nodes: [{ id: 'x1', type: 'junction', label: 'C', link: 'fresh' }, { id: 'x2', type: 'junction', label: 'D', link: 'fresh' }] }], undefined),
    );
    expect(error.code).toBe('INVALID_INPUT');
  });
});

describe('a label set on one junction of a group', () => {
  it('renames the whole group, in every view, and says how many others it renamed', () => {
    const result = applyUpdate(spread(), [], [{ op: 'update', id: 'out', set: { label: 'Settle' } }], undefined);
    expect(labels(result.file, 'handoff')).toEqual([['out', 'Settle'], ['in', 'Settle']]);
    // Another group that read the same is its own.
    expect(labels(result.file, 'refunds')).toEqual([['other', 'A']]);
    expect(result.advisories).toContain('Junction group "handoff" reads "Settle" everywhere it is drawn: 1 other junction renamed with it.');
  });

  it('is renamed the same way from inside a view, and the last label set wins', () => {
    const result = applyUpdate(spread(), ['orders'], [
      { op: 'update', id: 'in', set: { label: 'First' } },
      { op: 'update', id: 'in', set: { label: 'Second' } },
    ], undefined);
    expect(labels(result.file, 'handoff')).toEqual([['out', 'Second'], ['in', 'Second']]);
  });

  it('leaves an unlinked junction’s label its own', () => {
    const file = build({ nodes: [{ id: 'a', type: 'junction', label: 'A' }, { id: 'b', type: 'junction', label: 'A' }, { id: 's', type: 'service', label: 'S' }] });
    const result = applyUpdate(file, [], [{ op: 'update', id: 'a', set: { label: 'Z' } }], undefined);
    expect(result.file.nodes.find((node) => node.id === 'b')!.text).toBe('A');
    expect(result.advisories.some((line) => line.includes('Junction group'))).toBe(false);
  });
});

describe('a junction joining a group', () => {
  it('takes the label the group already has, added or linked, and is told so', () => {
    const added = applyUpdate(spread(), [], [{ op: 'add', nodes: [{ id: 'third', type: 'junction', label: 'Hand-off', link: 'handoff' }] }], undefined);
    expect(labels(added.file, 'handoff')).toEqual([['out', 'A'], ['third', 'A'], ['in', 'A']]);
    expect(added.advisories.join('\n')).toMatch(/Junction "third" joined group "handoff" and reads "A", the group's label, not "Hand-off"/);

    const linked = applyUpdate(spread(), [], [{ op: 'update', id: 'other', set: { link: 'handoff' } }], undefined);
    expect(labels(linked.file, 'handoff')).toEqual([['out', 'A'], ['other', 'A'], ['in', 'A']]);
  });

  it('renames the group instead when the same update sets its label', () => {
    const result = applyUpdate(spread(), [], [{ op: 'update', id: 'other', set: { link: 'handoff', label: 'Pay' } }], undefined);
    expect(labels(result.file, 'handoff')).toEqual([['out', 'Pay'], ['other', 'Pay'], ['in', 'Pay']]);
  });

  it('keeps its own label when the group is new', () => {
    const result = applyUpdate(spread(), [], [{ op: 'add', nodes: [{ id: 'n1', type: 'junction', label: 'Q', link: 'fresh' }, { id: 'n2', type: 'junction', label: 'Q', link: 'fresh' }] }], undefined);
    expect(labels(result.file, 'fresh')).toEqual([['n1', 'Q'], ['n2', 'Q']]);
    expect(result.advisories.some((line) => line.includes('joined group'))).toBe(false);
  });
});

describe('a review of a change that reached another view', () => {
  it('lists every junction the rename changed, each with the view it is in', () => {
    const file = spread();
    const result = applyUpdate(file, [], [{ op: 'update', id: 'out', set: { label: 'Settle' } }], undefined);
    const rows = diffForReview(file, result.file, []);
    const inside = rows.find((row) => row.id === 'in');
    expect(inside).toMatchObject({ change: 'modified', path: ['orders'] });
    expect(inside!.fields!.find((field) => field.field === 'label')).toMatchObject({ before: 'A', after: 'Settle' });
    // Sent from inside the room, the top-level junction is listed as well.
    const fromInside = applyUpdate(file, ['orders'], [{ op: 'update', id: 'in', set: { label: 'Settle' } }], undefined);
    const rowsInside = diffForReview(file, fromInside.file, ['orders']);
    expect(rowsInside.find((row) => row.id === 'out')).toMatchObject({ change: 'modified', path: [] });
    // A proposal reviews the same rows.
    const proposal = prepareProposal(file, [], [{ op: 'update', id: 'out', set: { label: 'Settle' } }], undefined, undefined);
    expect(JSON.stringify(proposal)).toContain('"in"');
  });

  it('lists nothing extra for a change that stayed in its view', () => {
    const file = spread();
    const result = applyUpdate(file, [], [{ op: 'update', id: 'checkout', set: { label: 'Checkout API' } }], undefined);
    expect(diffForReview(file, result.file, []).map((row) => row.id)).toEqual(['checkout']);
  });
});

describe('finding and renaming a junction group by name', () => {
  it('rename_element renames a linked group by its label', () => {
    const file = build({ nodes: [{ id: 'out', type: 'junction', label: 'Hand-off', link: 'handoff' }, { id: 'orders', type: 'service', label: 'Orders', inside: { nodes: [{ id: 'in', type: 'junction', label: 'Hand-off', link: 'handoff' }, { id: 'r', type: 'component', label: 'Rules' }] } }] });
    const patch = renamePatch(file, { from: 'Hand-off', to: 'Settle' });
    const result = applyUpdate(file, patch.view.inside, patch.ops, undefined);
    expect(labels(result.file, 'handoff')).toEqual([['out', 'Settle'], ['in', 'Settle']]);
  });

  it('rename_element refuses a label two groups share, and still prefers an architecture shape', () => {
    const error = refusal(() => renamePatch(spread(), { from: 'A', to: 'Z' }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(said(error)).toMatch(/More than one shape/);
    const shapes = build({ nodes: [{ id: 's', type: 'service', label: 'Pay' }, { id: 'j', type: 'junction', label: 'Pay', link: 'g' }] });
    expect(renamePatch(shapes, { from: 'Pay', to: 'Billing' }).ops[0]).toMatchObject({ id: 's' });
  });

  it('a search by a link’s name finds every junction in it, with the link', () => {
    const file = spread();
    const lookup = readLookup(file, { query: 'handoff' }, 'r1', 'd') as { matches: Array<Record<string, unknown>> };
    expect(lookup.matches.map((match) => [match.id, match.link, match.view])).toEqual([['out', 'handoff', { inside: [] }], ['in', 'handoff', { inside: ['orders'] }]]);
    const edit = readEdit(file, { query: 'handoff' }, 'r1', 'd') as { matches: Array<Record<string, unknown>> };
    expect(edit.matches.map((match) => [match.id, match.link])).toEqual([['out', 'handoff'], ['in', 'handoff']]);
  });

  it('is in the catalog an agent sees first', () => {
    expect(JSON.stringify(TOOLS)).toContain('"link":{"type":"string","description":"Junction group id"}');
  });
});

describe('as an MCP client sends it', () => {
  const create = {
    requestId: 'r1',
    title: 'Payments',
    nodes: [
      { id: 'orders', type: 'service', label: 'Order Service' },
      { id: 'a-out', type: 'junction', label: 'A', link: 'payment-handoff' },
      { id: 'a-in', type: 'junction', label: 'A', link: 'payment-handoff' },
      { id: 'adapter', type: 'service', label: 'Partner Adapter' },
    ],
    relationships: [
      { id: 'to-a', from: 'orders', to: 'a-out' },
      { id: 'from-a', from: 'a-in', to: 'adapter' },
    ],
  };
  const update = (ops: unknown[]) => ({ requestId: 'r2', diagramId: 'd', expectedRevision: 'f:1', ops });

  it('passes the published schemas for create, add, link, relabel and unlink, in an update, a preview and a proposal', () => {
    expect(() => validateToolInput('create_diagram', create)).not.toThrow();
    for (const ops of [
      [{ op: 'add', nodes: [{ id: 'a3', type: 'junction', label: 'A', link: 'payment-handoff' }] }],
      [{ op: 'update', id: 'a-in', set: { link: 'refunds' } }],
      [{ op: 'update', id: 'a-in', set: { label: 'Settle' } }],
      [{ op: 'update', id: 'a-in', set: { link: null } }],
    ]) {
      expect(() => validateToolInput('update_diagram', update(ops)), JSON.stringify(ops)).not.toThrow();
      const { requestId: _id, ...preview } = update(ops);
      expect(() => validateToolInput('preview_diagram', preview), JSON.stringify(ops)).not.toThrow();
      expect(() => validateToolInput('submit_proposal', { ...update(ops), summary: 'Junctions' }), JSON.stringify(ops)).not.toThrow();
    }
  });

  it('refuses at the schema what is not a name', () => {
    expect(() => validateToolInput('update_diagram', update([{ op: 'update', id: 'a-in', set: { link: 7 } }]))).toThrow(AgentError);
    expect(() => validateToolInput('create_diagram', { ...create, nodes: [{ id: 'j', type: 'junction', label: 'A', link: 'x'.repeat(65) }] })).toThrow(AgentError);
  });

  it('builds the diagram it describes, with the two ends one point', () => {
    const file = build(create);
    expect(labels(file, 'payment-handoff')).toEqual([['a-out', 'A'], ['a-in', 'A']]);
    expect(file.edges.map((edge) => edge.id).sort()).toEqual(['from-a', 'to-a']);
  });
});
