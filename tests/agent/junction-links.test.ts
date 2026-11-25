import { describe, expect, it } from 'vitest';
import { capabilities } from '../../src/agent/capabilities';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { CREATE_FIELDS, SET_FIELDS } from '../../src/agent/fields';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { FULL_TOOLS } from '../../src/agent/schema';
import type { DraftDocument } from '../../src/document/types';
import { deserializeDocument } from '../../src/export/project';
import { counterpartsOf, membersOf } from '../../src/junctions/groups';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'Payments', ...raw }, 'd_junctionlink').text);
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

/** Two parts of one flow, joined by a pair of linked junctions instead of a long connector. */
const payments = () =>
  build({
    nodes: [
      { id: 'orders', type: 'service', label: 'Order Service' },
      { id: 'out', type: 'junction', label: 'A', link: 'payment-handoff' },
      { id: 'in', type: 'junction', label: 'A', link: 'payment-handoff' },
      { id: 'adapter', type: 'service', label: 'Partner Adapter' },
      { id: 'spare', type: 'junction', label: 'B' },
    ],
    relationships: [
      { id: 'leaves', from: 'orders', to: 'out' },
      { id: 'arrives', from: 'in', to: 'adapter' },
    ],
  });

describe('linked junctions through the agent contract', () => {
  it('are created with a link the agent names, without relying on matching labels', () => {
    const file = payments();
    expect(membersOf(file, 'payment-handoff').map((member) => member.node.id)).toEqual(['out', 'in']);
    expect(counterpartsOf(file, 'out').map((member) => member.node.id)).toEqual(['in']);
    expect('link' in file.nodes.find((node) => node.id === 'spare')!).toBe(false);
    // No relationship was added for it: only the two that were drawn.
    expect(file.edges.map((edge) => edge.id).sort()).toEqual(['arrives', 'leaves']);
  });

  it('are read back with their link, and with every place each group is drawn', () => {
    const read = readDiagram(payments(), {}, 'r1', 'diagram') as { elements: Array<Record<string, unknown>>; linkedJunctions?: unknown };
    expect(read.elements.find((element) => element.id === 'out')).toMatchObject({ type: 'junction', label: 'A', link: 'payment-handoff' });
    expect('link' in read.elements.find((element) => element.id === 'spare')!).toBe(false);
    expect(read.linkedJunctions).toEqual([{ link: 'payment-handoff', label: 'A', places: [{ id: 'out', view: [] }, { id: 'in', view: [] }] }]);
    // A diagram with none says nothing about them.
    const plain = readDiagram(build({ nodes: [{ id: 'j', type: 'junction', label: 'X' }, { id: 's', type: 'service', label: 'S' }] }), {}, 'r1', 'diagram');
    expect('linkedJunctions' in plain).toBe(false);
  });

  it('names the view each place is in when a group reaches into an inside view', () => {
    const file = build({
      nodes: [
        { id: 'top', type: 'junction', label: 'A', link: 'handoff' },
        { id: 'orders', type: 'service', label: 'Orders', inside: { nodes: [{ id: 'deep', type: 'junction', label: 'A', link: 'handoff' }, { id: 'rules', type: 'component', label: 'Rules' }] } },
      ],
    });
    const top = readDiagram(file, {}, 'r1', 'diagram') as { linkedJunctions: unknown };
    expect(top.linkedJunctions).toEqual([{ link: 'handoff', label: 'A', places: [{ id: 'top', view: [] }, { id: 'deep', view: ['orders'] }] }]);
    const inside = readDiagram(file, { view: { inside: ['orders'] } }, 'r1', 'diagram') as { linkedJunctions: unknown };
    expect(inside.linkedJunctions).toEqual(top.linkedJunctions);
  });

  it('are linked, moved to another group and unlinked by an update, and added already linked', () => {
    const file = payments();
    const { file: joined } = applyUpdate(file, [], [{ op: 'update', id: 'spare', set: { link: 'payment-handoff', label: 'A' } }], undefined);
    expect(membersOf(joined, 'payment-handoff').map((member) => member.node.id)).toEqual(['out', 'in', 'spare']);

    const { file: moved } = applyUpdate(joined, [], [{ op: 'update', id: 'spare', set: { link: 'refunds' } }], undefined);
    expect(membersOf(moved, 'payment-handoff').map((member) => member.node.id)).toEqual(['out', 'in']);
    expect(membersOf(moved, 'refunds').map((member) => member.node.id)).toEqual(['spare']);

    const { file: unlinked } = applyUpdate(moved, [], [{ op: 'update', id: 'in', set: { link: null } }], undefined);
    expect('link' in unlinked.nodes.find((node) => node.id === 'in')!).toBe(false);
    // The shape and its connector stay.
    expect(unlinked.edges.some((edge) => edge.id === 'arrives')).toBe(true);

    const { file: added } = applyUpdate(file, [], [{ op: 'add', nodes: [{ id: 'third', type: 'junction', label: 'A', link: 'payment-handoff' }] }], undefined);
    expect(membersOf(added, 'payment-handoff').map((member) => member.node.id)).toEqual(['out', 'in', 'third']);
  });

  it('what a read returns for a junction is what an update takes back unchanged', () => {
    const file = payments();
    const read = readDiagram(file, {}, 'r1', 'diagram') as { elements: Array<{ id: string; link?: string }> };
    const out = read.elements.find((element) => element.id === 'out')!;
    const { file: same } = applyUpdate(file, [], [{ op: 'update', id: 'out', set: { link: out.link } }], undefined);
    expect(same.nodes.find((node) => node.id === 'out')).toEqual(file.nodes.find((node) => node.id === 'out'));
  });

  it('refuses a link on anything that is not a junction, and one that is not a name', () => {
    const onService = refusal(() => build({ nodes: [{ id: 's', type: 'service', label: 'S', link: 'x' }] }));
    expect(onService.message + JSON.stringify(onService.details ?? '')).toMatch(/link belongs to a junction/);
    const file = payments();
    const set = (link: unknown) => refusal(() => applyUpdate(file, [], [{ op: 'update', id: 'orders', set: { link } }], undefined));
    expect(set('x').message + JSON.stringify(set('x').details ?? '')).toMatch(/link belongs to a junction|INVALID|UNSUPPORTED/);
    for (const bad of ['', '   ', 'x'.repeat(65), 7]) {
      expect(() => applyUpdate(file, [], [{ op: 'update', id: 'spare', set: { link: bad } }], undefined)).toThrow(AgentError);
    }
  });

  it('is part of the published contract: both field lists, the schemas and the field notes', () => {
    expect(CREATE_FIELDS.element).toContain('link');
    expect(SET_FIELDS.element).toContain('link');
    expect(JSON.stringify(FULL_TOOLS)).toContain('"link"');
    expect(JSON.stringify(capabilities({ topics: ['readability'] }))).toMatch(/Junctions only: the name of a group/);
  });
});
