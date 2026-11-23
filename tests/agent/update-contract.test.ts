import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { validateToolInput } from '../../src/agent/contract';
import { AgentError } from '../../src/agent/errors';
import { OP_FIELDS, SET_FIELDS } from '../../src/agent/fields';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { ENTRY_TOOLS, FULL_TOOLS, TOOLS } from '../../src/agent/schema';
import { deserializeDocument, serializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

/**
 * The update contract as an agent meets it, from a JetBrains Junie run that spent its action limit on
 * "invalid input … incorrect fields in the update operations". Its request was not captured; the
 * payloads here are the ones that reproduce that answer from the path it took: one dispatcher tool,
 * help for update_diagram, then ops built from names rather than ids. What each test holds is that
 * the published contract says what the app accepts, and that a refusal names the real mistake.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Problem = { code: string; path: string; message: string };

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'Shop', ...raw }, 'd_contract0001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

/** A small container view with a nested component view: what an agent is asked to keep up to date. */
const shop = () =>
  build({
    level: 'container',
    groups: [{ id: 'platform', label: 'Shop platform', kind: 'system' }],
    nodes: [
      { id: 'shopper', type: 'person', label: 'Shopper' },
      { id: 'web', type: 'service', label: 'Storefront', technology: 'React', group: 'platform' },
      { id: 'api', type: 'service', label: 'Orders API', technology: 'Spring Boot 3', description: 'Takes orders', group: 'platform', inside: { nodes: [{ id: 'ctl', type: 'component', label: 'Order controller' }] } },
      { id: 'db', type: 'database', label: 'Orders DB', technology: 'PostgreSQL', group: 'platform' },
    ],
    relationships: [
      { id: 'browse', from: 'shopper', to: 'web', label: 'Browses' },
      { id: 'order', from: 'web', to: 'api', label: 'POST /orders' },
      { id: 'write', from: 'api', to: 'db', label: 'Writes' },
    ],
    flows: [{ id: 'checkout', title: 'Checkout', steps: ['browse', 'order', 'write'] }],
    notes: [{ id: 'region', text: 'Assumption: one region', about: 'api' }],
  });

const request = (ops: unknown, extra: Record<string, unknown> = {}) => ({ requestId: 'r', diagramId: 'd', expectedRevision: 'f:1', ops, ...extra });

/** A call as the app runs it: the schema first, then the engine, on the view the request names. */
function update(file: DraftDocument, ops: unknown[], inside: string[] = []): DraftDocument {
  validateToolInput('update_diagram', request(ops, inside.length ? { view: { inside } } : {}), { deferUpdateSet: true });
  return applyUpdate(file, inside, ops, undefined).file;
}

function refusal(run: () => unknown): AgentError {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const problemsOf = (error: AgentError) => error.details?.problems as Problem[];
const read = (file: DraftDocument, path: string[] = []) => readDiagram(file, path.length ? { view: { inside: path } } : {}, 'f:1', 'd') as unknown as Loose;
const saved = (file: DraftDocument) => {
  const parsed = deserializeDocument(serializeDocument(file));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
};

const discovered = (name: string) => (TOOLS.find((tool) => tool.name === name)!.inputSchema as Loose).properties.ops as Loose;
const full = FULL_TOOLS.find((tool) => tool.name === 'update_diagram')!.inputSchema as Loose;
const fullOps: Loose[] = full.properties.ops.items.oneOf;
const fullSet: Loose = fullOps.find((op) => op.properties.op.enum[0] === 'update')!.properties.set;

describe('what an agent is told about update ops is what the app accepts', () => {
  it('names every op, in discovery and in the full schema, as the engine knows them', () => {
    const names = Object.keys(OP_FIELDS);
    expect(discovered('update_diagram').items.properties.op.enum).toEqual(names);
    expect(fullOps.map((op) => op.properties.op.enum[0])).toEqual(names);
    for (const op of fullOps) expect(Object.keys(op.properties), op.properties.op.enum[0]).toEqual(OP_FIELDS[op.properties.op.enum[0]]);
    for (const name of names) expect(discovered('update_diagram').description).toContain(`op:"${name}"`);
  });

  it('publishes what set takes for each kind of target, and types every one of those fields', () => {
    for (const [target, fields] of Object.entries(SET_FIELDS)) {
      expect(discovered('update_diagram').description).toContain(`${target}: ${fields.join(',')}`);
      expect(fullSet.description).toContain(`${target}: ${fields.join(',')}`);
      // A field with no schema would vanish from the published JSON and be refused as unknown.
      for (const field of fields) expect(fullSet.properties[field], `${target}.${field}`).toBeDefined();
    }
    expect(Object.keys(fullSet.properties).sort()).toEqual([...new Set<string>(Object.values(SET_FIELDS).flat())].sort());
  });

  it('says in the one tool most agents see how help, a read and an update are called', () => {
    const entry = ENTRY_TOOLS[0];
    expect(entry.description).toContain('tool:"help", args:{}');
    expect(entry.description).toContain('args:{tool:"NAME"}');
    expect(entry.description).toContain('read_diagram');
    expect(entry.inputSchema.required).toEqual(['tool', 'args']);
  });

  it('takes back what a read returns: every field it reports is one set accepts for that target', () => {
    const file = shop();
    const view = read(file);
    // What a read derives or counts, and the view inside an element, which has ops of its own.
    const derived = new Set(['id', 'c4', 'attachmentCount', 'inside']);
    const back = (item: Loose) => Object.fromEntries(Object.entries(item).filter(([key]) => !derived.has(key)));
    for (const [list, target] of [['elements', 'element'], ['relationships', 'relationship'], ['groups', 'group'], ['flows', 'flow']] as const) {
      expect(view[list].length, list).toBeGreaterThan(0);
      for (const item of view[list] as Loose[]) {
        const set = back(item);
        for (const key of Object.keys(set)) expect(SET_FIELDS[target], `${list}/${item.id}/${key}`).toContain(key);
        // Sent straight back, it is a valid request that leaves the diagram as it was read.
        const after = update(file, [{ op: 'update', id: item.id, set }]);
        expect(read(after)[list].find((other: Loose) => other.id === item.id), `${list}/${item.id}`).toEqual(item);
      }
    }
  });
});

describe('a refused update names the real mistake', () => {
  it('reports a label sent as an id as the id, not as unsupported fields (the Junie loop)', () => {
    // Was: INVALID_INPUT "/ops/0/set/technology: unknown or unsupported field (takes label, text, kind,
    // code, language, about, attach)" — an attachment's fields, for a request whose fields were right.
    const error = refusal(() => update(shop(), [{ op: 'update', id: 'Orders API', set: { label: 'Order Service', technology: 'Kotlin', description: 'Takes and validates orders' } }]));
    expect(error.code).toBe('INVALID_REFERENCE');
    expect(problemsOf(error)).toHaveLength(1);
    expect(problemsOf(error)[0]).toMatchObject({ path: '/ops/0/id', message: 'nothing with id "Orders API" in this view; that is the label of id "api", and an op takes the id' });
    expect(error.hint).toMatch(/^Nothing was changed\..*read_diagram/);
    expect(error.retryable).toBeUndefined();
  });

  it('says which view holds an id that is not in the one addressed', () => {
    const nested = refusal(() => update(shop(), [{ op: 'update', id: 'ctl', set: { label: 'Controller', color: 'blue' } }]));
    expect(nested.message).toBe('/ops/0/id: nothing with id "ctl" in this view; it is in another view: send this op with view: {inside: ["api"]}');
    expect(update(shop(), [{ op: 'update', id: 'ctl', set: { label: 'Controller', color: 'blue' } }], ['api']).nodes.find((n) => n.id === 'api')?.inside?.nodes[0]?.text).toBe('Controller');
    const outer = refusal(() => update(shop(), [{ op: 'remove', ids: ['db'] }], ['api']));
    expect(outer.message).toBe('/ops/0/ids/0: nothing with id "db" in this view; it is in the top view: send this op without view');
    expect(refusal(() => update(shop(), [{ op: 'update', id: 'ghost', set: { technology: 'Go' } }])).message).toBe('/ops/0/id: nothing with id "ghost" in this view');
  });

  it('uses an exact id from another view ahead of a same-text label in this view', () => {
    const file = update(shop(), [{ op: 'update', id: 'ctl', set: { label: 'db' } }], ['api']);
    const change = refusal(() => update(file, [{ op: 'update', id: 'db', set: { technology: 'SQLite' } }], ['api']));
    expect(change.message).toMatch(/in the top view/);
    const removal = refusal(() => update(file, [{ op: 'remove', ids: ['ctl', 'db'] }], ['api']));
    expect(removal.details?.path).toBe('/ops/0/ids/1');
    expect(removal.message).toMatch(/in the top view/);
  });

  it('says to reorder an update when a later op adds its id and an existing label matches it', () => {
    const file = update(shop(), [{ op: 'update', id: 'web', set: { label: 'cache' } }]);
    const error = refusal(() => update(file, [
      { op: 'update', id: 'cache', set: { technology: 'Redis' } },
      { op: 'add', nodes: [{ id: 'cache', type: 'cache', label: 'Orders cache' }] },
    ]));
    expect(error.message).toContain('put that add before /ops/0');
    expect(error.details?.path).toBe('/ops/0/id');
  });

  it('resolves the target before set values and still checks values for a known field', () => {
    const file = shop();
    const badColor = { color: '#ff0000' };
    const missing = refusal(() => update(file, [{ op: 'update', id: 'Orders API', set: badColor }]));
    expect(missing.code).toBe('INVALID_REFERENCE');
    expect(missing.details?.path).toBe('/ops/0/id');
    const wrongKind = refusal(() => update(file, [{ op: 'update', id: 'order', set: { technology: 42 } }]));
    expect(wrongKind.message).toContain('not a field of a relationship ("order")');
    const badValue = refusal(() => update(file, [{ op: 'update', id: 'api', set: badColor }]));
    expect(badValue.details?.path).toBe('/ops/0/set/color');
    expect(badValue.message).toContain('must be one of neutral');
  });

  it('accepts the documented kind of an open point in both schema and patch validation', () => {
    const ops = [
      { op: 'add', openPoints: [{ id: 'rollout', kind: 'tentative', about: ['api'] }] },
      { op: 'update', id: 'rollout', set: { kind: 'awaiting' } },
    ];
    validateToolInput('update_diagram', request(ops));
    expect(update(shop(), ops).openPoints).toMatchObject([{ id: 'rollout', kind: 'awaiting' }]);
  });

  it('names the target kind and its fields when a field belongs to another kind', () => {
    const file = shop();
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['order', { technology: 'HTTPS' }, /^\/ops\/0\/set\/technology: not a field of a relationship \("order"\); it takes label, semantic, kind, .*route$/],
      ['checkout', { label: 'Checkout flow' }, /^\/ops\/0\/set\/label: not a field of a flow \("checkout"\); use title; it takes title, color, steps, variantOf$/],
      ['platform', { description: 'Everything we run' }, /not a field of a group \("platform"\); it takes label, kind, group, color, place$/],
      ['api', { kind: 'async' }, /not a field of an element \("api"\); it takes label, type, description, technology, replicas, color, group, evidence, place$/],
      ['region', { color: 'rose' }, /not a field of an attachment \("region"\); it takes label, text, kind, code, language, about, attach$/],
    ];
    for (const [id, set, message] of cases) {
      const error = refusal(() => update(file, [{ op: 'update', id, set }]));
      expect(error.code, id).toBe('INVALID_INPUT');
      expect(error.message, id).toMatch(message);
      expect(error.hint, id).toMatch(/^Nothing was changed\. Correct each field/);
    }
  });

  it('names the op and field of a malformed request before the engine sees it, with what to send', () => {
    const cases: [unknown[], string][] = [
      [[{ op: 'update', id: 'api', label: 'Orders' }], '/ops/0/label: unknown field (takes op, id, set)'],
      [[{ op: 'update', id: 'api', set: { name: 'Orders' } }], '/ops/0/set/name: unknown field; use label'],
      [[{ op: 'update', id: 'api', set: { color: '#ff0000' } }], '/ops/0/set/color: must be one of neutral, teal, blue, violet, amber, rose, green'],
      [[{ op: 'updateNode', id: 'api', set: { label: 'Orders' } }], '/ops/0/op: must be one of add, update, remove, setLevel, arrange, moveInside, moveOutside'],
      [[{ op: 'remove', id: 'api' }], '/ops/0/id: unknown field (takes op, ids, cascade)'],
      [[{ op: 'add', nodes: [{ id: 'cache', label: 'Cache' }] }], '/ops/0/nodes/0/type: is required'],
      [[{ op: 'add', relationships: [{ id: 'e', source: 'api', target: 'db' }] }], '/ops/0/relationships/0/source: unknown field; use from'],
      [[{ op: 'update', id: 'api', set: { label: 'ok' } }, { op: 'update', id: 'db', set: { shape: 'cylinder' } }], '/ops/1/set/shape: unknown field'],
    ];
    for (const [ops, first] of cases) {
      const error = refusal(() => validateToolInput('update_diagram', request(ops)));
      expect(error.code).toBe('INVALID_INPUT');
      expect((error.details?.problems as string[] | undefined)?.[0]).toBe(first);
      expect(error.details?.path).toBe(first.split(':')[0]);
      expect(error.hint).toMatch(/^Nothing was changed\./);
    }
    expect(refusal(() => validateToolInput('update_diagram', { requestId: 'r', diagramId: 'd', ops: [{ op: 'arrange' }] })).message).toBe('/expectedRevision: is required');
    expect(refusal(() => validateToolInput('update_diagram', request(JSON.stringify([{ op: 'arrange' }])))).message).toBe('/ops: must be array');
  });

  it('applies several ops as one change, and none of them when one is refused', () => {
    const file = shop();
    const before = serializeDocument(file);
    const error = refusal(() => update(file, [
      { op: 'update', id: 'api', set: { label: 'Order Service' } },
      { op: 'add', nodes: [{ id: 'cache', type: 'cache', label: 'Cache', group: 'platform' }] },
      { op: 'update', id: 'Orders DB', set: { technology: 'PostgreSQL 17' } },
    ]));
    expect(error.details?.path).toBe('/ops/2/id');
    expect(serializeDocument(file)).toBe(before);
    expect(read(file).elements.map((e: Loose) => e.label)).toContain('Orders API');
  });
});

describe('an agent keeps a diagram up to date', () => {
  it('reads, adds, updates, restyles, removes, recovers from a refusal, and reads its changes back from the saved file', () => {
    let file = shop();
    expect(read(file).elements.map((e: Loose) => e.id)).toEqual(['shopper', 'web', 'api', 'db']);

    // Create shapes and connections.
    file = saved(update(file, [{
      op: 'add',
      nodes: [{ id: 'events', type: 'queue', label: 'Order events', technology: 'Kafka', group: 'platform' }, { id: 'mailer', type: 'service', label: 'Mailer', group: 'platform' }],
      relationships: [{ id: 'publish', from: 'api', to: 'events', label: 'Publishes OrderPlaced' }, { id: 'consume', from: 'events', to: 'mailer', label: 'OrderPlaced' }],
    }]));
    // Update labels, properties and styles; several ops in one request.
    file = saved(update(file, [
      { op: 'update', id: 'api', set: { label: 'Order Service', technology: 'Kotlin', description: 'Takes and validates orders', color: 'blue' } },
      { op: 'update', id: 'write', set: { label: 'Inserts order', lineStyle: 'curved', color: 'teal' } },
      { op: 'update', id: 'platform', set: { label: 'Shop', color: 'violet' } },
      { op: 'update', id: 'checkout', set: { title: 'Place an order', steps: ['browse', 'order', 'write', 'publish'] } },
    ]));
    // An intentionally invalid request, then the correction its refusal describes.
    const wrong = [{ op: 'update', id: 'Mailer', set: { technology: 'Node.js 22' } }, { op: 'remove', ids: ['web'] }];
    const error = refusal(() => update(file, wrong));
    const fix = /label of id "([^"]+)"/.exec(error.message)?.[1];
    expect(fix).toBe('mailer');
    expect(read(file).elements.map((e: Loose) => e.id)).toContain('web');
    file = saved(update(file, [{ ...wrong[0], id: fix }, wrong[1]]));
    // And one inside a nested view.
    file = saved(update(file, [{ op: 'add', nodes: [{ id: 'repo', type: 'component', label: 'Order repository' }], relationships: [{ id: 'save', from: 'ctl', to: 'repo', label: 'Saves' }] }], ['api']));

    const view = read(file);
    const element = (id: string) => view.elements.find((e: Loose) => e.id === id);
    expect(view.elements.map((e: Loose) => e.id)).toEqual(['shopper', 'api', 'db', 'events', 'mailer']);
    expect(element('api')).toMatchObject({ label: 'Order Service', technology: 'Kotlin', description: 'Takes and validates orders', color: 'blue', group: 'platform' });
    expect(element('mailer')).toMatchObject({ technology: 'Node.js 22' });
    expect(view.relationships.map((r: Loose) => r.id).sort()).toEqual(['consume', 'publish', 'write']);
    expect(view.relationships.find((r: Loose) => r.id === 'write')).toMatchObject({ label: 'Inserts order', color: 'teal' });
    expect(view.groups[0]).toMatchObject({ label: 'Shop', color: 'violet' });
    expect(view.flows[0]).toMatchObject({ title: 'Place an order', steps: ['write', 'publish'] });
    expect(read(file, ['api']).elements.map((e: Loose) => e.id)).toEqual(['ctl', 'repo']);
  });
});
