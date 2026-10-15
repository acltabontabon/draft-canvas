import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { buildImplementationContext } from '../../src/agent/context';
import { validateToolInput } from '../../src/agent/contract';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { diffForReview } from '../../src/agent/proposal';
import { readDiagram, viewPathOf } from '../../src/agent/read';
import { TOOLS } from '../../src/agent/schema';
import { viewOf } from '../../src/depth/tree';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument, DraftFlowStep } from '../../src/document/types';

/**
 * Everything a person can author by hand, through MCP: a flow's presentation (captions, highlights,
 * spotlight steps, pinned views), notes as code snippets and labels attached anywhere the editor
 * allows (and taken off again), a connector's options and ends, and the C4 levels — drawing inside an
 * element and moving shapes back out.
 */

function composed(raw: Record<string, unknown>) {
  const result = compose({ title: 'T', ...raw }, 'd_authoring00');
  const parsed = deserializeDocument(result.text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { file: parsed.document, receipt: result.receipt };
}

const build = (raw: Record<string, unknown>) => composed(raw).file;

const base = () =>
  build({
    groups: [{ id: 'sys', label: 'Orders', kind: 'system' }],
    nodes: [
      { id: 'user', type: 'person', label: 'Customer' },
      { id: 'api', type: 'api', label: 'Orders API', group: 'sys' },
      { id: 'db', type: 'database', label: 'Orders DB', group: 'sys' },
      { id: 'pay', type: 'external-system', label: 'Payments' },
    ],
    relationships: [
      { id: 'u', from: 'user', to: 'api', label: 'Places orders' },
      { id: 'd', from: 'api', to: 'db', label: 'Stores' },
      { id: 'p', from: 'api', to: 'pay', label: 'Charges' },
    ],
    flows: [{ id: 'f', title: 'Order', steps: ['u', 'd', 'p'] }],
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

const update = (file: DraftDocument, ops: unknown[], path: string[] = []) => applyUpdate(file, path, ops, undefined);
const flowOf = (file: DraftDocument, id = 'f') => file.flows.find((f) => f.id === id)!;
const readSteps = (file: DraftDocument, id = 'f') => (readDiagram(file, {}, 'r', 'd').flows as { id: string; steps: unknown[] }[]).find((f) => f.id === id)!.steps;

/** The request as the page boundary and an independent JSON Schema validator both see it. */
const ajv = new Ajv({ strict: false, allErrors: true });
const updateSchema = ajv.compile(TOOLS.find((tool) => tool.name === 'update_diagram')!.inputSchema);
function publishable(ops: unknown[], view?: { inside: string[] }) {
  const request = { requestId: 'r-1', diagramId: 'd', expectedRevision: 'f:1', ops, ...(view ? { view } : {}) };
  expect(updateSchema(request), JSON.stringify(updateSchema.errors)).toBe(true);
  expect(() => validateToolInput('update_diagram', request)).not.toThrow();
}

describe('flow presentation', () => {
  it('lights more with a step, and opens on a spotlight step with no relationship, from create', () => {
    const file = build({
      nodes: [
        { id: 'user', type: 'person', label: 'Customer' },
        { id: 'api', type: 'api', label: 'Orders API' },
        { id: 'db', type: 'database', label: 'Orders DB' },
      ],
      relationships: [
        { id: 'u', from: 'user', to: 'api' },
        { id: 'd', from: 'api', to: 'db' },
      ],
      flows: [{ id: 'f', title: 'Order', steps: [{ spotlight: ['api', 'db'], caption: 'The system' }, { relationship: 'u', highlight: ['db', 'd'] }, 'd'] }],
    });
    expect(flowOf(file).steps).toEqual<DraftFlowStep[]>([
      { id: 'f.s1', extraNodeIds: ['api', 'db'], caption: 'The system' },
      { id: 'f.s2', edgeId: 'u', extraNodeIds: ['db'], extraEdgeIds: ['d'] },
      { id: 'f.s3', edgeId: 'd' },
    ]);
    expect(readSteps(file)).toEqual([{ frame: 'f.s1', spotlight: ['api', 'db'], caption: 'The system' }, { relationship: 'u', highlight: ['db', 'd'] }, 'd']);
  });

  it('keeps a flow\'s variant link from create (it was dropped there before), and says when one is refused', () => {
    const { file, receipt } = composed({
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'b', type: 'service', label: 'B' },
      ],
      relationships: [{ id: 'r', from: 'a', to: 'b' }],
      flows: [
        { id: 'main', title: 'Main', steps: ['r'] },
        { id: 'fail', title: 'Failure', steps: ['r'], variantOf: 'main' },
        { id: 'chain', title: 'Chain', steps: ['r'], variantOf: 'fail' },
      ],
    });
    expect(flowOf(file, 'fail').variantOf).toBe('main');
    expect(flowOf(file, 'chain').variantOf).toBeUndefined();
    expect(JSON.stringify(receipt)).toContain('Flow \\"chain\\" was not linked as a variant of \\"fail\\"');
    expect(refusal(() => compose({ title: 'T', nodes: [{ id: 'a', type: 'service', label: 'A' }], flows: [{ id: 'x', title: 'X', steps: [], variantOf: 'nope' }] }, 'd')).code).toBe('INVALID_REFERENCE');
  });

  it('edits a step\'s highlights in place — replaced, cleared, and kept when left out', () => {
    const ops = [{ op: 'update', id: 'f', set: { steps: [{ relationship: 'u', highlight: ['sys', 'p'] }, 'd', { relationship: 'p', caption: 'Charged once' }] } }];
    publishable(ops);
    const lit = update(base(), ops).file;
    const [first, second, third] = flowOf(lit).steps;
    expect(first).toMatchObject({ edgeId: 'u', extraNodeIds: ['sys'], extraEdgeIds: ['p'] });
    expect(second!.extraNodeIds).toBeUndefined();
    expect(third).toMatchObject({ edgeId: 'p', caption: 'Charged once' });
    // Left out: kept. Sent back as read: nothing changes.
    expect(update(lit, [{ op: 'update', id: 'f', set: { steps: ['u', 'd', 'p'] } }]).file.flows).toEqual(lit.flows);
    expect(update(lit, [{ op: 'update', id: 'f', set: { steps: readSteps(lit) } }]).file.flows).toEqual(lit.flows);
    // null clears.
    const cleared = update(lit, [{ op: 'update', id: 'f', set: { steps: [{ relationship: 'u', highlight: null }, 'd', 'p'] } }]).file;
    expect(flowOf(cleared).steps[0]!.extraNodeIds).toBeUndefined();
    expect(flowOf(cleared).steps[0]!.extraEdgeIds).toBeUndefined();
    expect(flowOf(cleared).steps[0]!.id).toBe(first!.id);
  });

  it('adds a spotlight step, edits a frame step it reads back, and drops a pinned camera only when told', () => {
    const file = base();
    file.flows[0] = { ...file.flows[0]!, steps: [{ id: 'f.frame', extraNodeIds: ['sys'], viewport: { x: 1, y: 2, zoom: 1 } }, ...file.flows[0]!.steps.map((s, i) => (i === 0 ? { ...s, viewport: { x: 0, y: 0, zoom: 2 } } : s))] };
    expect(readSteps(file).slice(0, 2)).toEqual([{ frame: 'f.frame', spotlight: ['sys'], pinnedView: true }, { relationship: 'u', pinnedView: true }]);
    const ops = [{ op: 'update', id: 'f', set: { steps: [{ spotlight: ['user', 'api'], caption: 'Who and what' }, { frame: 'f.frame', caption: 'Inside Orders', pinnedView: false }, { relationship: 'u', pinnedView: true }, 'd', 'p'] } }];
    publishable(ops);
    const next = flowOf(update(file, ops).file);
    expect(next.steps[0]).toMatchObject({ extraNodeIds: ['user', 'api'], caption: 'Who and what' });
    expect(next.steps[0]!.edgeId).toBeUndefined();
    expect(next.steps[1]).toEqual({ id: 'f.frame', extraNodeIds: ['sys'], caption: 'Inside Orders' });
    expect(next.steps[2]!.viewport).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(new Set(next.steps.map((s) => s.id)).size).toBe(5);
  });

  it('refuses a step that would light nothing, a camera it would have to invent, and ids it can\'t light', () => {
    const steps = (first: unknown) => [{ op: 'update', id: 'f', set: { steps: [first, 'd', 'p'] } }];
    expect(refusal(() => update(base(), steps({ relationship: 'u', pinnedView: true }))).message).toContain('only a person pins a camera');
    expect(refusal(() => update(base(), steps({ spotlight: [] }))).code).toBe('INVALID_INPUT');
    expect(refusal(() => update(base(), steps({ relationship: 'u', highlight: ['u'] }))).message).toContain("this step's own relationship");
    expect(refusal(() => update(base(), steps({ relationship: 'u', highlight: ['ghost'] }))).code).toBe('INVALID_REFERENCE');
    expect(refusal(() => update(base(), [{ op: 'add', flows: [{ id: 'g', title: 'G', steps: [{ frame: 'x' }] }] }])).message).toContain('spotlight');
  });
});

describe('notes, code snippets and labels', () => {
  it('attaches a code snippet to an existing element, relationship and boundary, keeping its indentation', () => {
    const code = '  if (retries > 3) {\n    park(message);\n  }';
    const ops = [
      {
        op: 'add',
        notes: [
          { id: 'snip', kind: 'code', language: 'typescript', code: `\n${code}\n\n`, about: 'api' },
          { id: 'wire', kind: 'code', language: 'json', code: '{"orderId": "o-1"}', about: 'u' },
          { id: 'owner', kind: 'code', code: 'team: orders', about: 'sys', attach: true },
        ],
      },
    ];
    publishable(ops);
    const next = update(base(), ops).file;
    expect(next.nodes.find((n) => n.id === 'api')!.attachments?.[0]).toMatchObject({ id: 'snip', type: 'code', language: 'typescript', code });
    expect(next.edges.find((e) => e.id === 'u')!.attachments?.[0]).toMatchObject({ id: 'wire', type: 'code', language: 'json' });
    expect(next.nodes.find((n) => n.id === 'sys')!.attachments?.[0]).toMatchObject({ id: 'owner', type: 'code', language: 'plaintext' });
    // Read as the chips they are: on the element, the relationship and the boundary.
    const read = readDiagram(next, { include: ['attachments'] }, 'r', 'd') as { groups: { id: string; attachments?: unknown[] }[] };
    expect(read.groups.find((g) => g.id === 'sys')!.attachments).toEqual([{ id: 'owner', kind: 'code', language: 'plaintext', code: 'team: orders' }]);
  });

  it('puts a free code card and a label beside an element, each sized to what it holds', () => {
    const long = Array.from({ length: 14 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`).join('\n');
    const next = update(base(), [{ op: 'add', notes: [{ id: 'card', kind: 'code', code: long, about: 'pay', attach: false }, { id: 'tag', kind: 'label', text: 'PCI scope', about: 'pay', attach: false }] }]).file;
    const card = next.nodes.find((n) => n.id === 'card')!;
    const tag = next.nodes.find((n) => n.id === 'tag')!;
    expect(card).toMatchObject({ type: 'code', code: long, language: 'plaintext' });
    expect(card.width).toBeGreaterThan(380);
    expect(card.height).toBeGreaterThan(180);
    expect(tag).toMatchObject({ type: 'text', text: 'PCI scope' });
    const notes = readDiagram(next, {}, 'r', 'd').notes as { id: string; kind: string }[];
    expect(notes.find((n) => n.id === 'card')!.kind).toBe('code');
    expect(notes.find((n) => n.id === 'tag')!.kind).toBe('label');
  });

  it('refuses what the editor refuses: words on a snippet, code on a note, a label on a connector or a boundary', () => {
    const add = (note: Record<string, unknown>) => update(base(), [{ op: 'add', notes: [{ id: 'x', ...note }] }]);
    expect(refusal(() => add({ kind: 'code', code: 'a', text: 'b', about: 'api' })).message).toContain('code, not text');
    expect(refusal(() => add({ kind: 'note', text: 'a', code: 'b', about: 'api' })).message).toContain('only a note of kind "code"');
    expect(refusal(() => add({ kind: 'label', text: 'a', about: 'u' })).message).toContain("can't attach to a relationship");
    expect(refusal(() => add({ kind: 'code', about: 'api' })).code).toBe('INVALID_INPUT');
  });

  it('edits a snippet and moves it to a boundary, takes it off as a free card and folds it back — always the same id', () => {
    const withSnippet = update(base(), [{ op: 'add', notes: [{ id: 'snip', kind: 'code', code: 'a()', about: 'api' }] }]).file;
    const edited = update(withSnippet, [{ op: 'update', id: 'snip', set: { code: 'b()', language: 'java', about: 'sys' } }]).file;
    expect(edited.nodes.find((n) => n.id === 'api')!.attachments ?? []).toHaveLength(0);
    expect(edited.nodes.find((n) => n.id === 'sys')!.attachments?.[0]).toMatchObject({ id: 'snip', code: 'b()', language: 'java' });

    const ops = [{ op: 'update', id: 'snip', set: { attach: false, about: 'pay' } }];
    publishable(ops);
    const free = update(edited, ops).file;
    expect(free.nodes.find((n) => n.id === 'sys')!.attachments ?? []).toHaveLength(0);
    const card = free.nodes.find((n) => n.id === 'snip')!;
    expect(card).toMatchObject({ type: 'code', code: 'b()', language: 'java' });
    const pay = free.nodes.find((n) => n.id === 'pay')!;
    const gap = Math.max(pay.x - (card.x + card.width), card.x - (pay.x + pay.width), pay.y - (card.y + card.height), card.y - (pay.y + pay.height));
    expect(gap).toBeLessThan(200);

    const back = update(free, [{ op: 'update', id: 'snip', set: { attach: true, about: 'd', code: 'c()' } }]).file;
    expect(back.nodes.some((n) => n.id === 'snip')).toBe(false);
    expect(back.edges.find((e) => e.id === 'd')!.attachments?.[0]).toMatchObject({ id: 'snip', type: 'code', code: 'c()', language: 'java', width: card.width, height: card.height });
  });

  it('detaches a note from a connector beside one of its ends, and edits a free label and code card in place', () => {
    const withNote = update(base(), [{ op: 'add', notes: [{ id: 'n', text: 'Idempotent', about: 'p' }, { id: 'tag', kind: 'label', text: 'Edge', about: 'pay', attach: false }, { id: 'card', kind: 'code', code: 'x', about: 'user', attach: false }] }]).file;
    const free = update(withNote, [{ op: 'update', id: 'n', set: { attach: false } }]).file;
    expect(free.nodes.find((n) => n.id === 'n')).toMatchObject({ type: 'note', text: 'Idempotent' });
    const edited = update(free, [
      { op: 'update', id: 'tag', set: { text: 'Edge of the system boundary', color: 'amber' } },
      { op: 'update', id: 'card', set: { code: 'one()\ntwo()\nthree()', language: 'sql' } },
    ]).file;
    expect(edited.nodes.find((n) => n.id === 'tag')).toMatchObject({ text: 'Edge of the system boundary', accent: 'amber' });
    expect(edited.nodes.find((n) => n.id === 'card')).toMatchObject({ code: 'one()\ntwo()\nthree()', language: 'sql' });
    expect(refusal(() => update(edited, [{ op: 'update', id: 'card', set: { kind: 'note' } }])).message).toContain("can't become a note");
    expect(refusal(() => update(edited, [{ op: 'update', id: 'n', set: { kind: 'code' } }])).message).toContain("can't become a code snippet");
  });

  it('refuses to fold a card that has connectors, or onto a host that is full', () => {
    const file = base();
    file.nodes.push({ id: 'card', type: 'note', x: 2000, y: 2000, width: 200, height: 80, z: 9, text: 'x', noteKind: 'note' });
    file.edges.push({ id: 'line', source: 'card', target: 'api', directed: true, routing: 'smoothstep' });
    expect(refusal(() => update(file, [{ op: 'update', id: 'card', set: { attach: true, about: 'db' } }])).message).toContain('connectors');
    const full = base();
    full.edges = full.edges.map((e) => (e.id === 'u' ? { ...e, attachments: [1, 2, 3, 4].map((i) => ({ id: `a${i}`, type: 'note' as const, text: 't' })) } : e));
    expect(refusal(() => update(full, [{ op: 'add', notes: [{ id: 'more', text: 'y', about: 'u' }] }])).code).toBe('LIMIT_EXCEEDED');
  });

  it('carries attached and nearby code into the implementation context', () => {
    const next = update(base(), [{ op: 'add', notes: [{ id: 'snip', kind: 'code', language: 'typescript', code: 'charge(order)', about: 'p' }] }]).file;
    const context = buildImplementationContext(next, [], 'r', 'd', { flow: 'f' }) as { snippets: unknown[] };
    expect(context.snippets).toEqual([{ id: 'snip', language: 'typescript', provenance: 'attached', about: 'p', code: 'charge(order)' }]);
  });

  it('attaches notes and snippets to a boundary and a relationship at create', () => {
    const file = build({
      groups: [{ id: 'sys', label: 'Orders', kind: 'system' }],
      nodes: [
        { id: 'api', type: 'api', label: 'Orders API', group: 'sys' },
        { id: 'db', type: 'database', label: 'Orders DB', group: 'sys' },
      ],
      relationships: [{ id: 'd', from: 'api', to: 'db' }],
      notes: [
        { id: 'own', text: 'Owned by the orders team.', about: 'sys', attach: true },
        { id: 'sql', kind: 'code', language: 'sql', code: 'select * from orders', about: 'd' },
        { id: 'head', text: 'Heads the boundary.', about: 'sys' },
      ],
    });
    expect(file.nodes.find((n) => n.id === 'sys')!.attachments?.map((a) => a.id)).toEqual(['own']);
    expect(file.edges[0]!.attachments?.[0]).toMatchObject({ id: 'sql', type: 'code', language: 'sql' });
    expect(file.nodes.find((n) => n.id === 'head')).toMatchObject({ type: 'note', parentId: 'sys' });
  });

  it('attaches a note to a starter\'s own element at create (it was lost before)', () => {
    const file = build({ starter: { id: 'microservices' }, notes: [{ id: 'why', text: 'Routes by path.', about: 'gateway' }] });
    expect(file.nodes.find((n) => n.id === 'gateway')?.attachments?.find((a) => a.id === 'why')).toMatchObject({ type: 'note', text: 'Routes by path.' });
  });
});

describe('connector options and ends', () => {
  it('sets colour, line style and a labelled reply line, and reads them back', () => {
    const ops = [{ op: 'add', nodes: [{ id: 'inv', type: 'api', label: 'Inventory' }], relationships: [{ id: 'i', from: 'api', to: 'inv', label: 'Reserves', color: 'violet', lineStyle: 'curved', response: '200 Reserved' }] }];
    publishable(ops);
    const next = update(base(), ops).file;
    expect(next.edges.find((e) => e.id === 'i')).toMatchObject({ accent: 'violet', routing: 'bezier', hasResponse: true, response: '200 Reserved' });
    const read = (readDiagram(next, {}, 'r', 'd').relationships as { id: string }[]).find((r) => r.id === 'i');
    expect(read).toMatchObject({ color: 'violet', lineStyle: 'curved', response: '200 Reserved' });
    const plain = update(next, [{ op: 'update', id: 'i', set: { response: true, lineStyle: 'stepped', color: null } }]).file.edges.find((e) => e.id === 'i')!;
    expect(plain).toMatchObject({ hasResponse: true, routing: 'smoothstep' });
    expect(plain.response).toBeUndefined();
    expect(plain.accent).toBeUndefined();
    const gone = update(next, [{ op: 'update', id: 'i', set: { response: false } }]).file.edges.find((e) => e.id === 'i')!;
    expect(gone.hasResponse).toBeUndefined();
    expect(gone.response).toBeUndefined();
  });

  it('keeps a reply line to a synchronous call, and delivery attempts to a dead-letter route', () => {
    expect(refusal(() => update(base(), [{ op: 'update', id: 'd', set: { response: 'rows' } }])).message).toContain('synchronous call');
    expect(refusal(() => update(base(), [{ op: 'update', id: 'u', set: { deliveryAttempts: 3 } }])).message).toContain('dead-letter');
    expect(refusal(() => update(base(), [{ op: 'update', id: 'u', set: { lineStyle: null } }])).message).toContain('cannot be cleared');
    const { file: next, advisories } = update(base(), [{ op: 'add', relationships: [{ id: 'w', from: 'pay', to: 'db', response: true }] }]);
    expect(next.edges.find((e) => e.id === 'w')!.hasResponse).toBeUndefined();
    expect(advisories.join(' ')).toContain('reply line');

    const dlq = build({
      nodes: [
        { id: 'q', type: 'queue', label: 'Orders' },
        { id: 'dl', type: 'dead-letter-queue', label: 'Orders DLQ' },
      ],
      relationships: [{ id: 'dead', from: 'q', to: 'dl', deliveryAttempts: 5 }],
    });
    expect(dlq.edges[0]).toMatchObject({ semantic: 'deadLetters', deliveryAttempts: 5 });
    expect(update(dlq, [{ op: 'update', id: 'dead', set: { deliveryAttempts: null } }]).file.edges[0]!.deliveryAttempts).toBeUndefined();
  });

  it('re-points and reverses a relationship in place — id, label, flow steps and attachments kept', () => {
    const file = update(base(), [{ op: 'add', notes: [{ id: 'why', text: 'Card only', about: 'p' }] }]).file;
    const stepIds = flowOf(file).steps.map((s) => s.id);
    const ops = [{ op: 'update', id: 'p', set: { to: 'db' } }];
    publishable(ops);
    const moved = update(file, [{ op: 'update', id: 'd', set: { from: 'user', to: 'db' } }, { op: 'update', id: 'p', set: { from: 'pay', to: 'api' } }]).file;
    expect(moved.edges.find((e) => e.id === 'd')).toMatchObject({ source: 'user', target: 'db', label: 'Stores' });
    const reversed = moved.edges.find((e) => e.id === 'p')!;
    expect(reversed).toMatchObject({ source: 'pay', target: 'api', label: 'Charges' });
    expect(reversed.attachments?.map((a) => a.id)).toEqual(['why']);
    expect(flowOf(moved).steps.map((s) => s.id)).toEqual(stepIds);
    expect(refusal(() => update(file, [{ op: 'update', id: 'p', set: { to: 'api' } }])).message).toContain('to itself');
    expect(refusal(() => update(file, [{ op: 'update', id: 'p', set: { from: 'user', to: 'api' } }])).message).toContain('already runs');
    expect(refusal(() => update(file, [{ op: 'update', id: 'p', set: { to: 'sys' } }])).code).toBe('INVALID_REFERENCE');
  });

  it('infers an inferred relationship again for what it now connects, and leaves a chosen one alone', () => {
    const file = build({
      nodes: [
        { id: 'svc', type: 'service', label: 'Service' },
        { id: 'db', type: 'database', label: 'Store' },
        { id: 'db2', type: 'database', label: 'Archive' },
        { id: 'q', type: 'queue', label: 'Jobs' },
      ],
      relationships: [{ id: 'r', from: 'svc', to: 'db' }],
    });
    expect(file.edges[0]).toMatchObject({ semantic: 'readsWrites', semanticsOrigin: 'inferred' });
    expect(update(file, [{ op: 'update', id: 'r', set: { to: 'q' } }]).file.edges[0]).toMatchObject({ target: 'q', semantic: 'command', semanticsOrigin: 'inferred' });
    const chosen = update(file, [{ op: 'update', id: 'r', set: { semantic: 'reads' } }]).file;
    expect(update(chosen, [{ op: 'update', id: 'r', set: { to: 'db2' } }]).file.edges[0]).toMatchObject({ target: 'db2', semantic: 'reads', semanticsOrigin: 'explicit' });
  });
});

describe('look inside (C4 levels)', () => {
  it('draws the inside of an element that has none yet, at the level the add names', () => {
    const file = base();
    expect(readDiagram(file, { view: { inside: ['api'] } }, 'r', 'd').view).toMatchObject({ empty: true });
    const path = viewPathOf(file, { inside: ['api'] });
    const ops = [{ op: 'add', level: 'component', nodes: [{ id: 'handler', type: 'component', label: 'Order handler' }, { id: 'repo', type: 'component', label: 'Order repository' }], relationships: [{ id: 'hr', from: 'handler', to: 'repo' }] }];
    publishable(ops, { inside: ['api'] });
    const next = update(file, ops, [...path]).file;
    const room = viewOf(next, ['api'])!;
    expect(room.nodes.map((n) => n.id)).toEqual(['handler', 'repo']);
    expect(room.level).toBe('component');
    const read = readDiagram(next, { include: ['views'] }, 'r', 'd') as { views: unknown[]; elements: { id: string; inside?: unknown }[] };
    expect(read.views).toEqual([{ inside: ['api'], owner: { id: 'api', label: 'Orders API', type: 'api' }, level: 'component', elements: 2, relationships: 1, flows: 0 }]);
    expect(read.elements.find((e) => e.id === 'api')!.inside).toMatchObject({ level: 'component', elements: 2 });
  });

  it('refuses an inside view for an element that can\'t hold one', () => {
    for (const inside of [['db'], ['user'], ['api', 'nothing']]) expect(refusal(() => viewPathOf(base(), { inside })).code).toBe('NOT_FOUND');
    expect(refusal(() => viewPathOf(base(), { inside: ['db'] })).message).toContain("can't have one");
  });

  it('moves shapes out of an inside view beside the owner, connectors to what stays meeting the owner', () => {
    // Nothing outside the Orders system in its way, so it can grow to hold what moves out.
    const roomy = update(base(), [{ op: 'remove', ids: ['pay'] }]).file;
    const file = update(roomy, [{ op: 'add', nodes: [{ id: 'handler', type: 'component', label: 'Handler' }, { id: 'cache', type: 'cache', label: 'Cache' }, { id: 'warm', type: 'worker', label: 'Warmer' }], relationships: [{ id: 'hc', from: 'handler', to: 'cache', label: 'Reads' }, { id: 'wc', from: 'warm', to: 'cache', label: 'Fills' }], flows: [{ id: 'fill', title: 'Fill', steps: ['wc'] }] }], ['api']).file;
    const ops = [{ op: 'moveOutside', ids: ['cache', 'warm'] }];
    publishable(ops, { inside: ['api'] });
    const { file: next, touched } = update(file, ops, ['api']);
    const top = next;
    const inside = viewOf(next, ['api'])!;
    expect(inside.nodes.map((n) => n.id)).toEqual(['handler']);
    expect(inside.edges).toEqual([]);
    expect(top.nodes.filter((n) => ['cache', 'warm'].includes(n.id)).map((n) => n.id).sort()).toEqual(['cache', 'warm']);
    expect(top.edges.find((e) => e.id === 'hc')).toMatchObject({ source: 'api', target: 'cache', label: 'Reads' });
    expect(top.edges.find((e) => e.id === 'wc')).toMatchObject({ source: 'warm', target: 'cache' });
    expect(top.flows.find((f) => f.id === 'fill')?.steps.map((s) => s.edgeId)).toEqual(['wc']);
    expect(touched.has('cache')).toBe(true);
    // One level up, still in the system the owner is in — which grows to hold them.
    expect(top.nodes.find((n) => n.id === 'cache')!.parentId).toBe('sys');
    const sys = top.nodes.find((n) => n.id === 'sys')!;
    for (const id of ['cache', 'warm']) {
      const m = top.nodes.find((n) => n.id === id)!;
      expect(m.x >= sys.x && m.y >= sys.y && m.x + m.width <= sys.x + sys.width && m.y + m.height <= sys.y + sys.height, `${id} inside sys`).toBe(true);
    }
    // Nothing else that was in the outer view moved.
    for (const node of file.nodes.filter((n) => n.id !== 'sys')) {
      const after = top.nodes.find((n) => n.id === node.id)!;
      expect([after.x, after.y]).toEqual([node.x, node.y]);
    }
    // The moved shapes sit clear of everything already there.
    const moved = top.nodes.filter((n) => ['cache', 'warm'].includes(n.id));
    for (const m of moved) {
      for (const other of top.nodes.filter((n) => !['cache', 'warm', 'sys'].includes(n.id))) {
        const apart = m.x >= other.x + other.width || other.x >= m.x + m.width || m.y >= other.y + other.height || other.y >= m.y + m.height;
        expect(apart, `${m.id} overlaps ${other.id}`).toBe(true);
      }
    }
  });

  it('never grows the owner\'s boundary into a neighbour: with no room inside, the shapes go just outside it, said so', () => {
    // Payments sits right under the Orders system, so the system can't grow down to hold the cache.
    const file = update(base(), [{ op: 'add', nodes: [{ id: 'h', type: 'component', label: 'Handler' }, { id: 'c', type: 'cache', label: 'Price cache' }], relationships: [{ id: 'hc', from: 'h', to: 'c', label: 'Reads prices' }] }], ['api']).file;
    const { file: next, quality, advisories } = update(file, [{ op: 'moveOutside', ids: ['c'] }], ['api']);
    expect(quality.errors).toEqual([]);
    const cache = next.nodes.find((n) => n.id === 'c')!;
    const sys = next.nodes.find((n) => n.id === 'sys')!;
    const pay = next.nodes.find((n) => n.id === 'pay')!;
    const overlaps = (a: typeof sys, b: typeof sys) => !(a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height);
    expect(overlaps(sys, pay)).toBe(overlaps(file.nodes.find((n) => n.id === 'sys')!, pay));
    if (cache.parentId !== 'sys') expect(advisories.join(' ')).toContain('placed outside boundary "sys"');
  });

  it('is reviewed from the view the shapes land in, so a proposal shows them moved, not deleted', () => {
    const file = update(base(), [{ op: 'add', nodes: [{ id: 'h', type: 'component', label: 'Handler' }, { id: 'c', type: 'cache', label: 'Cache' }], relationships: [{ id: 'hc', from: 'h', to: 'c' }] }], ['api']).file;
    const moved = update(file, [{ op: 'moveOutside', ids: ['c'] }], ['api']).file;
    const rows = diffForReview(file, moved, ['api']);
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'element', id: 'c', change: 'added', path: [] }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'element', id: 'c', change: 'removed', path: ['api'] }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'relationship', id: 'hc', change: 'added', path: [] }));
    // An edit that stays inside is still reviewed there.
    const inside = update(file, [{ op: 'update', id: 'h', set: { label: 'Order handler' } }], ['api']).file;
    expect(diffForReview(file, inside, ['api'])).toEqual([expect.objectContaining({ kind: 'element', id: 'h', change: 'modified' })]);
    expect(diffForReview(file, inside, ['api'])[0]!.path).toBeUndefined();
  });

  it('removes the inside view it empties, and refuses a story split across the levels or a move from the top', () => {
    const file = update(base(), [{ op: 'add', nodes: [{ id: 'h', type: 'component', label: 'Handler' }, { id: 'r', type: 'component', label: 'Repo' }, { id: 'v', type: 'component', label: 'Validator' }], relationships: [{ id: 'hr', from: 'h', to: 'r' }, { id: 'hv', from: 'h', to: 'v' }], flows: [{ id: 'save', title: 'Save', steps: ['hv', 'hr'] }] }], ['api']).file;
    const emptied = update(file, [{ op: 'moveOutside', ids: ['h', 'r', 'v'] }], ['api']).file;
    expect(emptied.nodes.find((n) => n.id === 'api')!.inside).toBeUndefined();
    expect(emptied.flows.some((f) => f.id === 'save')).toBe(true);
    // hr would leave with r while hv stays inside: the story would be split.
    expect(refusal(() => update(file, [{ op: 'moveOutside', ids: ['r'] }], ['api'])).message).toContain('Split that story');
    expect(refusal(() => update(file, [{ op: 'moveOutside', ids: ['api'] }])).message).toContain('top view');
  });
});
