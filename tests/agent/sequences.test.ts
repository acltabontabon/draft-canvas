import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { capabilities } from '../../src/agent/capabilities';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { TOOLS } from '../../src/agent/schema';
import { checkSequence } from '../../src/sequence/check';
import { messagesOf, sequenceOf } from '../../src/document/sequenceModel';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument, SeqFragment } from '../../src/document/types';

/**
 * A sequence through MCP: sent as a Mermaid `sequenceDiagram`, drawn as the app's own sequence
 * element, read back as the same text, and changed in place — with the participants that stand for
 * shapes of the diagram staying the shapes they stand for.
 */

const PLACE_ORDER = [
  'sequenceDiagram',
  '  actor shopper as Shopper',
  '  participant api as Orders API',
  '  participant db as Orders',
  '  shopper->>+api: POST /orders',
  '  api->>+db: INSERT order',
  '  db-->>-api: order id',
  '  alt payment accepted',
  '    api-->>shopper: 201 Created',
  '  else declined',
  '    api-->>-shopper: 402 Payment Required',
  '  end',
].join('\n');

function composed(raw: Record<string, unknown>) {
  const result = compose({ title: 'Store', ...raw }, 'd_sequences00');
  const parsed = deserializeDocument(result.text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { file: parsed.document, receipt: result.receipt as Record<string, unknown> };
}

const architecture = {
  nodes: [
    { id: 'shopper', type: 'person', label: 'Shopper' },
    { id: 'orders-api', type: 'api', label: 'Orders API', technology: 'Spring Boot' },
    { id: 'orders-db', type: 'sql-database', label: 'Orders', technology: 'PostgreSQL' },
  ],
  relationships: [
    { id: 'places', from: 'shopper', to: 'orders-api', label: 'Places orders' },
    { id: 'stores', from: 'orders-api', to: 'orders-db', label: 'Stores orders' },
  ],
};
const withSequence = (extra: Record<string, unknown> = {}) =>
  composed({ ...architecture, sequences: [{ id: 'place-order', title: 'Place an order', mermaid: PLACE_ORDER, links: { api: 'orders-api', db: 'orders-db' }, ...extra }] });

const sequenceIn = (file: DraftDocument, id = 'place-order') => file.nodes.find((node) => node.id === id)!;
const update = (file: DraftDocument, ops: unknown[]) => applyUpdate(file, [], ops, undefined);
const read = (file: DraftDocument, args: Record<string, unknown> = {}) => readDiagram(file, args, 'r1', 'd_sequences00');
const refusal = (run: () => unknown): AgentError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('a sequence, created by an agent', () => {
  it('is the app’s own sequence: participants, messages, a condition with two branches', () => {
    const { file, receipt } = withSequence();
    const node = sequenceIn(file);
    expect(node.type).toBe('sequence');
    expect(node.text).toBe('Place an order');
    const sequence = sequenceOf(node);
    expect(sequence.participants.map((participant) => participant.name)).toEqual(['Shopper', 'Orders API', 'Orders']);
    expect(messagesOf(sequence).map((message) => message.label)).toEqual(['POST /orders', 'INSERT order', 'order id', '201 Created', '402 Payment Required']);
    const fragment = sequence.items.find((item) => item.t === 'fragment') as SeqFragment;
    expect(fragment.operands.map((operand) => operand.guard)).toEqual(['payment accepted', 'declined']);
    // Nothing a person would be told to fix. (And nothing a reload repairs: `composed` reads the
    // file back from its saved text, through validation.)
    expect(checkSequence(sequence)).toEqual([]);
    expect((receipt.created as Record<string, number>).sequences).toBe(1);
  });

  it('a linked participant is the shape it stands for: its name, kind and technology', () => {
    const [shopper, api, db] = sequenceOf(sequenceIn(withSequence().file)).participants;
    expect(api).toMatchObject({ name: 'Orders API', type: 'service', serviceKind: 'api', technology: 'Spring Boot', ref: 'orders-api' });
    expect(db).toMatchObject({ name: 'Orders', type: 'database', databaseKind: 'sql', technology: 'PostgreSQL', ref: 'orders-db' });
    // Written under the element's own id, it is linked without being listed.
    expect(shopper).toMatchObject({ type: 'actor', ref: 'shopper' });
  });

  it('stands below the architecture, sized to what it holds, and moves nothing in it', () => {
    const plain = composed(architecture).file;
    const { file } = withSequence();
    const node = sequenceIn(file);
    const shapes = file.nodes.filter((entry) => entry.type !== 'sequence');
    expect(shapes.map((entry) => [entry.id, entry.x, entry.y])).toEqual(plain.nodes.map((entry) => [entry.id, entry.x, entry.y]));
    expect(node.y).toBeGreaterThan(Math.max(...shapes.map((entry) => entry.y + entry.height)));
    expect(node.width).toBeGreaterThan(300);
    expect(node.height).toBeGreaterThan(200);
  });

  it('says what the text asked for that is not drawn, and refuses text that is not a sequence', () => {
    const { receipt } = withSequence({ mermaid: PLACE_ORDER.replace('sequenceDiagram', 'sequenceDiagram\n  autonumber') });
    expect((receipt.advisories as string[]).join(' ')).toContain('message numbering');

    const notOne = refusal(() => withSequence({ mermaid: 'flowchart LR\n  a --> b' }));
    expect(JSON.stringify(notOne.details)).toContain('/sequences/0/mermaid');
    const noSuch = refusal(() => withSequence({ links: { api: 'nowhere' } }));
    expect(JSON.stringify(noSuch.details)).toContain('no element \\"nowhere\\" in this view');
    const noOne = refusal(() => withSequence({ links: { gateway: 'orders-api' } }));
    expect(JSON.stringify(noOne.details)).toContain('no participant \\"gateway\\"');
  });

  it('is in the published schema, and explained', () => {
    const create = TOOLS.find((tool) => tool.name === 'create_diagram')!;
    const validate = new Ajv({ strict: false }).compile(create.inputSchema);
    const request = { requestId: 'r', title: 'Store', ...architecture, sequences: [{ id: 'place-order', mermaid: PLACE_ORDER, links: { api: 'orders-api' } }] };
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, sequences: [{ id: 'place-order' }] })).toBe(false);
    expect(Object.keys(capabilities({ topics: ['sequences'] }).sequences as object)).toEqual(['what', 'write', 'links', 'order', 'edit', 'notDrawn', 'versusFlows']);
  });
});

describe('a sequence, read and changed', () => {
  it('reads back as text an update takes, apart from the architecture’s elements', () => {
    const { file } = withSequence();
    const view = read(file);
    expect((view.elements as { id: string }[]).map((element) => element.id)).toEqual(['shopper', 'orders-api', 'orders-db']);
    const [sequence] = view.sequences as { id: string; title: string; mermaid: string; links: Record<string, string>; participants: number; messages: number }[];
    expect(sequence).toMatchObject({ id: 'place-order', title: 'Place an order', participants: 3, messages: 5 });
    expect(sequence!.mermaid).toContain('sequenceDiagram');
    expect(Object.values(sequence!.links).sort()).toEqual(['orders-api', 'orders-db', 'shopper']);

    // Sent straight back, it is the same sequence, still linked.
    const again = update(file, [{ op: 'update', id: 'place-order', set: { mermaid: sequence!.mermaid } }]).file;
    const before = sequenceOf(sequenceIn(file));
    const after = sequenceOf(sequenceIn(again));
    expect(after.participants.map(({ id: _id, ...participant }) => participant)).toEqual(before.participants.map(({ id: _id, ...participant }) => participant));
    expect(messagesOf(after).map((message) => [message.kind, message.label])).toEqual(messagesOf(before).map((message) => [message.kind, message.label]));
  });

  it('new text replaces what it holds, in place: same id, same spot, room for what it now holds', () => {
    const { file } = withSequence();
    const was = sequenceIn(file);
    const longer = `${PLACE_ORDER}\n  api-)db: audit record\n  Note over api,db: written after the reply`;
    const result = update(file, [{ op: 'update', id: 'place-order', set: { mermaid: longer, title: 'Place an order, audited' } }]);
    const now = sequenceIn(result.file);
    expect([now.x, now.y, now.text]).toEqual([was.x, was.y, 'Place an order, audited']);
    expect(now.height).toBeGreaterThan(was.height);
    expect(messagesOf(sequenceOf(now)).at(-1)).toMatchObject({ kind: 'async', label: 'audit record' });
    expect(result.touched.has('place-order')).toBe(true);
  });

  it('links alone re-link the participants it has; null lets them all go', () => {
    const { file } = composed({ ...architecture, sequences: [{ id: 'place-order', mermaid: PLACE_ORDER.replace('actor shopper as Shopper', 'actor buyer as Buyer').replaceAll('shopper', 'buyer') }] });
    expect(sequenceOf(sequenceIn(file)).participants.map((participant) => participant.ref)).toEqual([undefined, undefined, undefined]);
    const names = Object.fromEntries((read(file).sequences as { mermaid: string }[])[0]!.mermaid.split('\n').flatMap((line) => {
      const declared = /^\s*(?:participant|actor|database|queue)\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line);
      return declared ? [[declared[2] ?? declared[1]!, declared[1]!]] : [];
    }));
    const linked = update(file, [{ op: 'update', id: 'place-order', set: { links: { [names['Orders API']!]: 'orders-api' } } }]).file;
    expect(sequenceOf(sequenceIn(linked)).participants.map((participant) => participant.ref)).toEqual([undefined, 'orders-api', undefined]);
    const free = update(linked, [{ op: 'update', id: 'place-order', set: { links: null } }]).file;
    expect(sequenceOf(sequenceIn(free)).participants.map((participant) => [participant.name, participant.ref])).toEqual([['Buyer', undefined], ['Orders API', undefined], ['Orders', undefined]]);
  });

  it('a shape an agent renames is renamed where it stands in a sequence', () => {
    const { file } = withSequence();
    const result = update(file, [{ op: 'update', id: 'orders-api', set: { label: 'Checkout API' } }]);
    expect(sequenceOf(sequenceIn(result.file)).participants[1]).toMatchObject({ name: 'Checkout API', ref: 'orders-api' });
    expect(result.touched.has('place-order')).toBe(true);
  });

  it('is added to a diagram that is already there, clear of it, and removed by id', () => {
    const plain = composed(architecture).file;
    const added = update(plain, [{ op: 'add', sequences: [{ id: 'place-order', mermaid: PLACE_ORDER, links: { api: 'orders-api', db: 'orders-db' } }] }]);
    const node = sequenceIn(added.file);
    expect(node.text).toBe('Sequence');
    expect(sequenceOf(node).participants.map((participant) => participant.ref)).toEqual(['shopper', 'orders-api', 'orders-db']);
    const overlaps = added.file.nodes.filter((other) => other.id !== node.id && other.x < node.x + node.width && node.x < other.x + other.width && other.y < node.y + node.height && node.y < other.y + other.height);
    expect(overlaps).toEqual([]);
    expect(added.counts.added).toBe(1);

    const removed = update(added.file, [{ op: 'remove', ids: ['place-order'] }]).file;
    expect(removed.nodes.map((entry) => entry.id).sort()).toEqual(['orders-api', 'orders-db', 'shopper']);
  });
});
