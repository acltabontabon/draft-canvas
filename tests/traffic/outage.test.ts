import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DraftEdge, DraftNode } from '../../src/document/types';
import { parseDocument } from '../../src/document/validate';
import { analyzeTraffic, canTakeDown, lostBy, mayTakeDown, outageOf, outageReview, type OutageTarget } from '../../src/traffic';
import { outageSummary } from '../../src/traffic/outage';
import { outageFact } from '../../src/traffic/technology';
import { edge, node } from './helpers';

function walk(nodes: readonly DraftNode[], edges: readonly DraftEdge[], target: string | OutageTarget) {
  const outage = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, typeof target === 'string' ? { id: target } : target);
  if (!outage) throw new Error('cannot be taken down');
  return outage;
}

const parsed = parseDocument(
  readFileSync(join(process.cwd(), 'tests/fixtures/outage/event-driven.draftcanvas'), 'utf8'),
);
if (!parsed.ok) throw new Error(parsed.error);
const starter = parsed.document;

/**
 * Nothing an outage says may claim a rate, a latency, a likelihood or a capacity: the drawing holds
 * none. Words too, not only numbers: "slower, not stopped" and "with less room than before" are a
 * latency and a capacity. (The names in these drawings use none of these words.)
 */
const INVENTED = /\b\d+(\.\d+)?\s*(%|ms|rps|\/min|\/s|per (second|minute))|\bp9\d\b|\blikely\b|\bprobab|\bslow(er|s|ly)?\b|\bfast(er)?\b|\bquick(er|ly)?\b|\b(less|more|no) room\b|\bheadroom\b|\bcapacity\b|\bthroughput\b|\blatenc|\boverload|\bunder load\b|\bbottleneck/i;

describe('outage walk — the Event-Driven starter', () => {
  it('follows a failing dependency back to the queue, the dead-letter queue and the missing replay', () => {
    const outage = walk(starter.nodes, starter.edges, 'external');

    expect(Object.fromEntries(outage.nodes)).toEqual({
      external: 'down',
      'integration-worker': 'failing',
      'integration-queue': 'retrying',
      'integration-dlq': 'catching',
      producer: 'unaffected',
      topic: 'unaffected',
      'projection-queue': 'unaffected',
      'projection-worker': 'unaffected',
      'read-store': 'unaffected',
    });
    expect(Object.fromEntries(outage.edges)).toEqual({
      'call-external': 'failing',
      'consume-integration': 'failing',
      'dead-letter': 'recovery',
    });
    expect(outage.notes.map((note) => [note.tone, note.note, note.focus])).toEqual([
      ['question', 'calls fail — no fallback drawn', ['integration-worker']],
      ['effect', 'retries, then dead-letters', ['integration-queue']],
      ['question', 'messages stay here — no replay drawn', ['integration-dlq']],
    ]);
    expect(outage.headline).toBe('External System is down. Producer Service, Domain Events and 3 more carry on.');
    expect(outage.notes[0]?.text).toMatch(/outside your system/);
    expect(outage.notes[2]).toMatchObject({
      ask: 'How are messages in the dead-letter queue replayed once External System is back?',
      fix: { kind: 'replay', from: 'integration-dlq', to: 'integration-queue' },
    });
  });

  it('turns the replay question into an answer once the route is drawn', () => {
    const replay = edge('replay', 'integration-dlq', 'integration-queue', { semantic: 'deliversTo', label: 'replays' });
    const outage = walk(starter.nodes, [...starter.edges, replay], 'external');

    expect(outage.notes.map((note) => [note.tone, note.note])).toContainEqual(['shield', "replay from here once it's back"]);
    expect(outage.notes.some((note) => note.id.startsWith('no-replay'))).toBe(false);
  });

  it('lets a queue hold for a consumer that is down, quiets what only it fed, and asks about the single instance', () => {
    const outage = walk(starter.nodes, starter.edges, 'projection-worker');

    expect(outage.nodes.get('projection-queue')).toBe('holding');
    expect(outage.nodes.get('read-store')).toBe('quiet');
    expect(outage.nodes.get('producer')).toBe('unaffected');
    expect(outage.edges.get('consume-projection')).toBe('stopped');
    expect(outage.edges.get('project')).toBe('stopped');
    expect(outage.notes.map((note) => [note.tone, note.note])).toEqual([
      ['shield', "holds messages while it's down"],
      ['effect', 'stops being updated'],
      ['question', 'one instance drawn'],
    ]);
    expect(outage.notes[0]?.text).toMatch(/When it returns the backlog arrives at once, and Read Store takes it with it\./);
    expect(outage.notes[2]?.fix).toEqual({ kind: 'instances', node: 'projection-worker' });
  });

  it('does not promise a queue with no product drawn outlasts the outage', () => {
    const outage = walk(starter.nodes, starter.edges, 'projection-worker');

    // Every queue has a retention or length limit. With no product named there is none to state.
    expect(outage.notes[0]?.text).toMatch(/Nothing drawn says how long or how much it keeps; past that, messages are lost or producers are turned away\./);
    expect(outage.notes[0]?.note).not.toMatch(/until/);

    const named = starter.nodes.map((item) => (item.id === 'projection-queue' ? { ...item, technology: 'Amazon SQS' } : item));
    const sqs = walk(named, starter.edges, 'projection-worker').notes[0]?.text;
    expect(sqs).toMatch(/Amazon SQS keeps a message for its retention period/);
    expect(sqs).not.toMatch(/Nothing drawn says how long/);
  });

  it('asks rather than guesses when a queue itself is down', () => {
    const outage = walk(starter.nodes, starter.edges, 'integration-queue');

    expect(outage.nodes.get('topic')).toBe('degraded');
    expect(outage.nodes.get('integration-worker')).toBe('quiet');
    expect(outage.notes[0]).toMatchObject({ tone: 'question', focus: ['topic'] });
  });

  it('says nothing it cannot read from the drawing, whatever is taken down', () => {
    for (const target of starter.nodes) {
      const analysis = analyzeTraffic({ nodes: starter.nodes, edges: starter.edges });
      const outage = outageOf(analysis, starter.nodes, starter.edges, { id: target.id, whole: true });
      if (!outage) continue;
      for (const line of outageSummary(outage)) expect(line).not.toMatch(INVENTED);
      // Every question can be kept as an open point on a shape.
      for (const note of outage.notes) {
        expect(note.focus.length).toBeGreaterThan(0);
        expect(note.tone === 'question').toBe(!!note.ask);
      }
    }
  });
});

describe('outage walk — flows', () => {
  const read = (target: string | OutageTarget, flows = starter.flows) => {
    const outage = outageOf(analyzeTraffic({ nodes: starter.nodes, edges: starter.edges }), starter.nodes, starter.edges, typeof target === 'string' ? { id: target } : target, flows);
    if (!outage) throw new Error('cannot be taken down');
    return outage;
  };

  it('names the first step of each flow that can no longer happen, in the flow’s own order', () => {
    const outage = read('external');

    expect(outage.flows.map((flow) => [flow.title, flow.state, flow.note])).toEqual([
      ['Update a projection', 'unaffected', 'carries on'],
      ['Reach an external system', 'breaks', 'breaks at step 3 of 4'],
      ['Handle a failed delivery', 'recovery', 'comes into use'],
    ]);
    expect(outage.flows[1]).toMatchObject({ step: 3, of: 4 });
    expect(outage.flows[1]?.text).toBe('Step 3 of 4 in Reach an external system (Integration Queue → Integration Worker) fails. 1 later step is hit too.');
  });

  it('says a step does not happen when nothing travels its connector', () => {
    const outage = read('projection-worker');
    const flow = outage.flows.find((item) => item.id === 'flow1');

    expect(flow?.note).toBe('breaks at step 3 of 4');
    expect(flow?.text).toMatch(/\(Projection Queue → Projection Worker\) doesn't happen: nothing travels it while Projection Worker is down\./);
    expect(outage.flows.find((item) => item.id === 'flow2')?.state).toBe('unaffected');
  });

  it('breaks a step over a connector the walk leaves unmarked when it touches what is down', () => {
    // An asynchronous call is not waited on, so the failure does not travel back — but the step
    // that makes the call still cannot happen.
    const nodes = [node('a', 'service', { text: 'Orders' }), node('b', 'service', { text: 'Mailer' }), node('c', 'service', { text: 'Audit' })];
    const edges = [edge('wait', 'c', 'a', { semantic: 'calls' }), edge('fire', 'a', 'b', { semantic: 'calls', async: true })];
    const flows = [{ id: 'f', title: 'Confirm', steps: [{ id: 's1', edgeId: 'wait' }, { id: 's2', edgeId: 'fire' }] }];
    const outage = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id: 'b' }, flows);

    expect(outage?.nodes.get('a')).toBe('degraded');
    // Nobody hears of a call that is not waited on, so the walk asks what becomes of it.
    expect(outage?.notes.find((note) => note.id.startsWith('unheard'))).toMatchObject({
      tone: 'question',
      note: "calls don't arrive — then what?",
      text: "Orders doesn't wait on Mailer, so it carries on. Nothing drawn says what becomes of the calls that don't arrive.",
      ask: "What happens to calls from Orders that don't reach Mailer?",
      focus: ['a'],
    });
    expect(outage?.nodes.get('c')).toBe('unaffected');
    expect(outage?.flows[0]).toMatchObject({ state: 'breaks', step: 2, of: 2 });
    expect(outage?.flows[0]?.text).toBe('Step 2 of 2 in Confirm (Orders → Mailer) fails.');
  });

  it('leaves every flow as drawn when one of several instances is down', () => {
    const nodes = starter.nodes.map((item) => (item.id === 'integration-worker' ? { ...item, replicas: 3 } : item));
    const outage = outageOf(analyzeTraffic({ nodes, edges: starter.edges }), nodes, starter.edges, { id: 'integration-worker' }, starter.flows);

    expect(outage?.instances).toEqual({ down: 1, of: 3 });
    expect(outage?.flows.every((flow) => flow.state === 'unaffected')).toBe(true);
  });

  it('skips a flow that names no connector of this graph, and reads none when none are given', () => {
    const flows = [...starter.flows, { id: 'gone', title: 'Stale', steps: [{ id: 's', edgeId: 'not-here' }] }, { id: 'empty', title: 'Empty', steps: [] }];

    expect(read('external', flows).flows.map((flow) => flow.id)).toEqual(['flow1', 'flow2', 'flow3']);
    expect(walk(starter.nodes, starter.edges, 'external').flows).toEqual([]);
  });

  it('tells the flows in the summary and invents nothing, whatever is taken down', () => {
    expect(outageSummary(read('external')).slice(-3)).toEqual([
      'Step 3 of 4 in Reach an external system (Integration Queue → Integration Worker) fails. 1 later step is hit too.',
      'Handle a failed delivery runs over a fallback or dead-letter route this outage brings into use.',
      'The Update a projection flow carries on.',
    ]);
    for (const target of starter.nodes) {
      const outage = outageOf(analyzeTraffic({ nodes: starter.nodes, edges: starter.edges }), starter.nodes, starter.edges, { id: target.id, whole: true }, starter.flows);
      if (!outage) continue;
      for (const flow of outage.flows) {
        expect(flow.text).not.toMatch(INVENTED);
        expect(flow.state === 'breaks').toBe(flow.step !== undefined);
      }
    }
  });
});

describe('outage walk — a flow breaks only where its own steps do', () => {
  // A storefront that reads a catalog and, for an order, calls a checkout that writes its store.
  const nodes = [
    node('shopper', 'actor', { text: 'Shopper' }),
    node('storefront', 'service', { text: 'Storefront' }),
    node('catalog', 'database', { text: 'Catalog' }),
    node('checkout', 'service', { text: 'Checkout' }),
    node('orders', 'database', { text: 'Orders' }),
  ];
  const edges = [
    edge('visit', 'shopper', 'storefront', { semantic: 'calls' }),
    edge('browse', 'storefront', 'catalog', { semantic: 'reads' }),
    edge('order', 'storefront', 'checkout', { semantic: 'calls' }),
    edge('save', 'checkout', 'orders', { semantic: 'writes' }),
  ];
  const steps = (...ids: string[]) => ids.map((edgeId, index) => ({ id: `s${index}`, edgeId }));
  const flows = [
    { id: 'browse', title: 'Browse', steps: steps('visit', 'browse') },
    { id: 'order', title: 'Order', steps: steps('visit', 'order', 'save') },
    { id: 'short', title: 'Order, in brief', steps: steps('visit', 'order') },
  ];
  const read = (target: string) => outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id: target }, flows)!;

  it('keeps a flow that goes on from a failing shape by steps that still work', () => {
    const outage = read('orders');

    // The walk reads the storefront as failing: it waits on the checkout, which waits on Orders.
    expect(outage.nodes.get('storefront')).toBe('failing');
    expect(outage.edges.get('visit')).toBe('failing');
    // Browsing goes on from the storefront to the catalog only, and that still works.
    expect(outage.flows[0]).toMatchObject({ state: 'unaffected', note: 'carries on' });
    expect(outage.flows[0]?.text).toBe("Browse carries on: Storefront fails only where it waits on something this flow doesn't use.");
    expect(outage.flows[1]).toMatchObject({ state: 'breaks', step: 1, of: 3 });
  });

  it('breaks a flow that says nothing further about the failing shape it reaches', () => {
    // The brief flow stops at the checkout, so the walk's reading of the checkout stands.
    expect(read('orders').flows[2]).toMatchObject({ state: 'breaks', step: 1, of: 2 });
  });

  it('ends on a loop of calls', () => {
    const loop = [...edges, edge('back', 'checkout', 'storefront', { semantic: 'calls' })];
    const round = [{ id: 'round', title: 'Round', steps: steps('order', 'back') }];
    expect(() => outageOf(analyzeTraffic({ nodes, edges: loop }), nodes, loop, { id: 'orders' }, round)).not.toThrow();
  });
});

describe('outage walk — a connector down', () => {
  const cut = (id: string, nodes = starter.nodes, edges = starter.edges) => {
    const outage = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id, connector: true }, starter.flows);
    if (!outage) throw new Error('cannot be taken down');
    return outage;
  };

  it('fails the caller that waits across it, while both ends stay up', () => {
    const outage = cut('call-external');

    expect(outage.connector).toEqual({ from: ['integration-worker'], to: ['external'] });
    expect(outage.lost).toEqual([]);
    expect(outage.headline).toBe("Integration Worker can't reach External System. Producer Service, Domain Events and 3 more carry on.");
    // Nothing is down: the far end is only no longer reached.
    expect([...outage.nodes.values()]).not.toContain('down');
    expect(outage.nodes.get('external')).toBe('quiet');
    expect(outage.nodes.get('integration-worker')).toBe('failing');
    expect(outage.nodes.get('integration-queue')).toBe('retrying');
    expect(outage.nodes.get('integration-dlq')).toBe('catching');
    expect(outage.notes[0]).toMatchObject({
      tone: 'question',
      text: "Integration Worker waits on External System and can't reach it, and nothing drawn says what happens instead.",
      ask: "What should Integration Worker do while it can't reach External System?",
    });
  });

  it('lets a queue hold what it cannot hand over, and says the consumer is cut off, not down', () => {
    const outage = cut('consume-projection');

    expect(outage.nodes.get('projection-queue')).toBe('holding');
    expect(outage.nodes.get('projection-worker')).toBe('quiet');
    expect(outage.notes[0]?.note).toBe("holds messages while it's cut off");
    expect(outage.notes[0]?.text).toMatch(/^Projection Queue keeps what arrives while Projection Worker can't be reached,/);
    expect(outage.notes[0]?.text).toMatch(/When the connection returns the backlog arrives at once/);
    expect(outageSummary(outage).join(' ')).not.toMatch(/while Projection Worker is down|When it returns/);
  });

  it('asks what becomes of a message that cannot be published across it', () => {
    const outage = cut('publish');

    expect(outage.nodes.get('producer')).toBe('degraded');
    expect(outage.edges.get('publish')).toBe('failing');
    expect(outage.notes[0]).toMatchObject({ tone: 'question', note: "can't publish — then what?", focus: ['producer'] });
  });

  it('reads a severed dead-letter route, though it carries nothing until something fails', () => {
    const outage = cut('dead-letter');

    expect(outage.notes.map((note) => [note.tone, note.note])).toEqual([['question', 'failures have nowhere to go']]);
    expect(outage.notes[0]?.ask).toBe("Where do failed messages from Integration Queue go while the dead-letter queue can't be reached?");
    // And with the provider's connector down instead, a severed dead-letter route is no way out.
    const edges = starter.edges.filter((edge) => edge.id !== 'dead-letter');
    expect(cut('call-external', starter.nodes, edges).notes.map((note) => note.note)).toContain('keeps redelivering — no dead-letter drawn');
  });

  it('asks about calls nobody waits on, and says a store that was only read is no longer read', () => {
    const nodes = [node('a', 'service', { text: 'Orders' }), node('b', 'service', { text: 'Mailer' }), node('c', 'service', { text: 'Audit' }), node('d', 'database', { text: 'Ledger' })];
    const edges = [
      edge('wait', 'c', 'a', { semantic: 'calls' }),
      edge('fire', 'a', 'b', { semantic: 'calls', async: true }),
      edge('also', 'c', 'b', { semantic: 'calls' }),
      edge('look', 'a', 'd', { semantic: 'reads' }),
    ];
    const read = (id: string) => outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id, connector: true })!;

    const fire = read('fire');
    expect(fire.nodes.get('a')).toBe('degraded');
    expect(fire.nodes.get('b')).toBe('unaffected');
    expect(fire.edges.get('fire')).toBe('failing');
    expect(fire.notes[0]).toMatchObject({ tone: 'question', note: "calls don't arrive — then what?", ask: "What happens to calls from Orders that don't reach Mailer?" });

    expect(read('look').notes.map((note) => note.note)).toContain('is no longer read');
  });

  it('leaves a store stale when its only writer can no longer reach it', () => {
    const nodes = [node('w', 'service', { text: 'Writer' }), node('r', 'service', { text: 'Reader' }), node('s', 'database', { text: 'Store' }), node('u', 'actor', { text: 'User' })];
    const edges = [edge('uw', 'u', 'w', { semantic: 'calls' }), edge('ur', 'u', 'r', { semantic: 'calls' }), edge('write', 'w', 's', { semantic: 'writes' }), edge('read', 'r', 's', { semantic: 'reads' })];
    const outage = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id: 'write', connector: true })!;

    expect(outage.nodes.get('s')).toBe('stale');
    expect(outage.notes.find((note) => note.id === 'stale:s')?.text).toMatch(/Reader keeps reading what was there when the connection from Writer to Store went down\./);
  });

  it('names a severed trunk by everything it led to', () => {
    const nodes = [node('a', 'service', { text: 'Gateway' }), node('j', 'ellipse'), node('b', 'service', { text: 'Orders' }), node('c', 'service', { text: 'Billing' })];
    const edges = [edge('trunk', 'a', 'j', { semantic: 'calls' }), edge('jb', 'j', 'b', { semantic: 'calls' }), edge('jc', 'j', 'c', { semantic: 'calls' })];
    const analysis = analyzeTraffic({ nodes, edges });
    const trunk = outageOf(analysis, nodes, edges, { id: 'trunk', connector: true })!;
    const branch = outageOf(analysis, nodes, edges, { id: 'jb', connector: true })!;

    expect(trunk.connector).toEqual({ from: ['a'], to: ['b', 'c'] });
    expect(trunk.headline).toMatch(/^Gateway can't reach Orders and Billing\./);
    expect(branch.connector).toEqual({ from: ['a'], to: ['b'] });
    expect(branch.headline).toMatch(/^Gateway can't reach Orders\./);
  });

  it('cannot take down a connector that carries no work, and invents nothing for any that does', () => {
    const nodes = [...starter.nodes, node('memo', 'note', { text: 'A note' })];
    const edges = [...starter.edges, edge('aside', 'memo', 'producer')];
    expect(outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id: 'aside', connector: true })).toBeNull();
    expect(outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id: 'nope', connector: true })).toBeNull();

    for (const item of starter.edges) {
      const outage = cut(item.id);
      for (const line of outageSummary(outage)) expect(line).not.toMatch(INVENTED);
      for (const note of outage.notes) expect(note.tone === 'question').toBe(!!note.ask);
      expect(outage.lost).toEqual([]);
    }
  });
});

describe('outage walk — work caught half-done', () => {
  const nodes = [
    node('user', 'actor', { text: 'Shopper' }),
    node('api', 'service', { text: 'Checkout' }),
    node('db', 'database', { text: 'Orders' }),
    node('pay', 'service', { text: 'Payments' }),
  ];
  const edges = [
    edge('ask', 'user', 'api', { semantic: 'calls' }),
    edge('save', 'api', 'db', { semantic: 'writes' }),
    edge('charge', 'api', 'pay', { semantic: 'calls' }),
  ];
  const steps = (...ids: string[]) => ids.map((edgeId, index) => ({ id: `s${index}`, edgeId }));
  const read = (target: OutageTarget, list = edges, flows: Parameters<typeof outageOf>[4] = []) => outageOf(analyzeTraffic({ nodes, edges: list }), nodes, list, target, flows)!;
  const about = (outage: ReturnType<typeof read>, kind: string) => outage.notes.find((note) => note.id.startsWith(kind));

  it('says "if" where no flow orders the two steps', () => {
    const note = about(read({ id: 'pay' }), 'half-done');

    expect(note).toMatchObject({ tone: 'question', note: 'half-done — what undoes it?', focus: ['api'] });
    expect(note?.text).toBe("Checkout also writes to Orders. If that comes before the step that waits on Payments, it has already happened when that step fails; the drawing doesn't say which comes first, or what undoes it.");
    expect(note?.ask).toBe('What undoes what Checkout has already done when the step that waits on Payments fails?');
  });

  it('says it has happened where a flow puts the write first, and nothing where it puts it after', () => {
    const first = [{ id: 'f', title: 'Place an order', steps: steps('ask', 'save', 'charge') }];
    expect(about(read({ id: 'pay' }, edges, first), 'half-done')?.text).toBe('In Place an order, Checkout writes to Orders before the step that waits on Payments, so that has already happened when that step fails. Nothing drawn undoes it.');

    const last = [{ id: 'f', title: 'Place an order', steps: steps('ask', 'charge', 'save') }];
    expect(about(read({ id: 'pay' }, edges, last), 'half-done')).toBeUndefined();
  });

  it('takes a drawn recovery action as the answer, and lights it', () => {
    const undo = { ...edge('undo', 'api', 'db', { semantic: 'compensates' }), compensationFor: 'save', compensationName: 'Cancel order' };
    const outage = read({ id: 'pay' }, [...edges, undo]);

    expect(about(outage, 'half-done')).toBeUndefined();
    expect(about(outage, 'undone')).toMatchObject({ tone: 'shield', note: 'a recovery action is drawn' });
    expect(about(outage, 'undone')?.text).toBe('Checkout also writes to Orders, and Cancel order is drawn to counteract it if the step that waits on Payments fails afterwards.');
    expect(outage.edges.get('undo')).toBe('recovery');
  });

  it('counts only what the drawing says changes something', () => {
    // An unlabelled data connector may be a read, and a plain call may be a question asked.
    const vague = [edge('ask', 'user', 'api', { semantic: 'calls' }), edge('save', 'api', 'db'), edge('charge', 'api', 'pay', { semantic: 'calls' })];
    expect(about(read({ id: 'pay' }, vague), 'half-done')).toBeUndefined();
    expect(about(read({ id: 'db' }), 'half-done')).toBeUndefined();
    // A command changes something by its name.
    const command = [edge('ask', 'user', 'api', { semantic: 'calls' }), edge('save', 'api', 'db', { semantic: 'writes' }), edge('charge', 'api', 'pay', { semantic: 'command' })];
    expect(about(read({ id: 'db' }, command), 'half-done')?.text).toMatch(/^Checkout also calls Payments\./);
  });

  it('asks whether a consumer is safe to run twice when its queue redelivers', () => {
    const queued = [
      node('jobs', 'queue', { text: 'Jobs' }),
      node('worker', 'service', { text: 'Worker' }),
      node('db', 'database', { text: 'Ledger' }),
      node('mail', 'service', { text: 'Mailer' }),
    ];
    const wires = [
      edge('take', 'jobs', 'worker', { semantic: 'consumes', async: true }),
      edge('post', 'worker', 'db', { semantic: 'writes' }),
      edge('send', 'worker', 'mail', { semantic: 'calls' }),
    ];
    const walk2 = (flows: Parameters<typeof outageOf>[4] = []) => outageOf(analyzeTraffic({ nodes: queued, edges: wires }), queued, wires, { id: 'mail' }, flows)!;

    const loose = walk2();
    expect(loose.nodes.get('jobs')).toBe('retrying');
    expect(about(loose, 'repeats')).toMatchObject({ tone: 'question', note: 'runs again on each redelivery', ask: 'Is Worker safe to run more than once on the same message?' });
    expect(about(loose, 'repeats')?.text).toBe("Jobs hands Worker the same message again each time it fails. Worker also writes to Ledger; if that comes before the step that waits on Mailer, it is repeated on every delivery. The drawing doesn't say which comes first.");
    // Redelivery is the recovery here, so it is not also asked what undoes the write.
    expect(about(loose, 'half-done')).toBeUndefined();

    const ordered = walk2([{ id: 'f', title: 'Settle', steps: steps('take', 'post', 'send') }]);
    expect(about(ordered, 'repeats')?.text).toBe('Jobs hands Worker the same message again each time it fails. In Settle, Worker writes to Ledger before the step that waits on Mailer, so that is repeated on every delivery.');
  });

  it('says a write and a message have come apart when the publish fails', () => {
    const outbox = [node('api', 'service', { text: 'Checkout' }), node('db', 'database', { text: 'Orders' }), node('bus', 'queue', { text: 'Order events' })];
    const wires = [edge('save', 'api', 'db', { semantic: 'writes' }), edge('tell', 'api', 'bus', { semantic: 'publishes', async: true })];
    const down = (flows: Parameters<typeof outageOf>[4] = []) => outageOf(analyzeTraffic({ nodes: outbox, edges: wires }), outbox, wires, { id: 'bus' }, flows)!;

    expect(about(down(), 'cannot-publish')?.text).toBe("Checkout hands work to Order events. Nothing drawn says what becomes of a message it can't accept. Checkout also writes to Orders; nothing drawn keeps that and the message in step.");
    expect(about(down([{ id: 'f', title: 'Order', steps: steps('save', 'tell') }]), 'cannot-publish')?.text).toMatch(/Checkout also writes to Orders, before this in Order; nothing drawn keeps/);
    // Published first in the flow: the write never happens, so nothing has come apart.
    expect(about(down([{ id: 'f', title: 'Order', steps: steps('tell', 'save') }]), 'cannot-publish')?.text).not.toMatch(/also writes/);
  });

  it('invents nothing, and every question can be kept as an open point', () => {
    for (const target of [{ id: 'pay' }, { id: 'db' }, { id: 'charge', connector: true }, { id: 'save', connector: true }]) {
      const outage = read(target, edges, [{ id: 'f', title: 'Place an order', steps: steps('ask', 'save', 'charge') }]);
      for (const line of outageSummary(outage)) expect(line).not.toMatch(INVENTED);
      for (const note of outage.notes) expect(note.tone === 'question').toBe(!!note.ask);
    }
  });
});

describe('outage review — every shape at once', () => {
  const review = outageReview(analyzeTraffic({ nodes: starter.nodes, edges: starter.edges }), starter.nodes, starter.edges, starter.flows);

  it('says of each shape exactly what taking it down says', () => {
    for (const entry of review.entries) {
      const outage = walk(starter.nodes, starter.edges, entry.id);
      const withFlows = outageOf(analyzeTraffic({ nodes: starter.nodes, edges: starter.edges }), starter.nodes, starter.edges, { id: entry.id }, starter.flows)!;
      expect(entry.questions).toBe(outage.notes.filter((note) => note.tone === 'question').length);
      expect(entry.flows.map((flow) => flow.id)).toEqual(withFlows.flows.filter((flow) => flow.state === 'breaks').map((flow) => flow.id));
      expect(entry.affected).toBe([...outage.nodes].filter(([id, state]) => id !== entry.id && state !== 'unaffected' && state !== 'down').length);
      expect(entry.text).not.toMatch(INVENTED);
      expect(entry.note).not.toMatch(INVENTED);
    }
  });

  it('orders by what the drawing says: the flows a loss breaks, then how much else it touches', () => {
    expect(review.entries.map((entry) => entry.id).slice(0, 3)).toEqual(['producer', 'topic', 'integration-queue']);
    expect(review.entries[0]).toMatchObject({ reaches: [], affected: 7, note: '7 other shapes affected · 3 flows break' });
    expect(review.entries[0]?.text).toBe('Without Producer Service: 7 other shapes are affected, and no one drawn waits on the result; Update a projection, Reach an external system and Handle a failed delivery break. The drawing leaves 1 question open.');
  });

  it('puts what reaches a person first, and takes a shape with several instances off the list', () => {
    const nodes = [
      node('shopper', 'actor', { text: 'Shopper' }),
      node('web', 'service', { text: 'Web' }),
      { ...node('api', 'service', { text: 'API' }), replicas: 2 },
      node('db', 'database', { text: 'Store' }),
      node('queue', 'queue', { text: 'Jobs' }),
      node('worker', 'service', { text: 'Worker' }),
    ];
    const edges = [
      edge('e1', 'shopper', 'web', { semantic: 'calls' }),
      edge('e2', 'web', 'api', { semantic: 'calls' }),
      edge('e3', 'api', 'db', { semantic: 'readsWrites' }),
      edge('e4', 'api', 'queue', { semantic: 'publishes', async: true }),
      edge('e5', 'queue', 'worker', { semantic: 'consumes', async: true }),
    ];
    const read = outageReview(analyzeTraffic({ nodes, edges }), nodes, edges);

    expect(read.covered).toEqual([{ id: 'api', name: 'API', instances: 2 }]);
    const reaching = read.entries.filter((entry) => entry.reaches.length > 0).map((entry) => entry.id);
    expect(reaching).toEqual(expect.arrayContaining(['web', 'db']));
    expect(read.entries.slice(0, reaching.length).every((entry) => entry.reaches.length > 0)).toBe(true);
    expect(read.entries.find((entry) => entry.id === 'db')?.note).toBe('Shopper sees the failure');
    expect(read.spared).toEqual([]);
    // A person runs nothing, so there is nothing of theirs to take down.
    expect(read.entries.some((entry) => entry.id === 'shopper')).toBe(false);
  });

  it('reads a Boundary as everything in it lost together', () => {
    const nodes = [
      node('zone', 'group', { text: 'Zone A' }),
      node('shopper', 'actor', { text: 'Shopper' }),
      { ...node('api', 'service', { text: 'API' }), parentId: 'zone' },
      { ...node('db', 'database', { text: 'Store' }), parentId: 'zone' },
    ];
    const edges = [edge('e1', 'shopper', 'api', { semantic: 'calls' }), edge('e2', 'api', 'db', { semantic: 'readsWrites' })];
    const read = outageReview(analyzeTraffic({ nodes, edges }), nodes, edges);
    const zone = read.entries.find((entry) => entry.id === 'zone');

    expect(zone).toMatchObject({ kind: 'boundary', name: 'everything in Zone A', reaches: ['shopper'], focus: ['zone'] });
    expect(zone?.text).toBe('Without everything in Zone A: Shopper sees the failure.');
  });

  it('lists connectors apart from shapes, each saying what cutting it says', () => {
    expect(review.connectors.map((entry) => entry.kind)).toEqual(review.connectors.map(() => 'connector'));
    for (const entry of review.connectors) {
      const outage = outageOf(analyzeTraffic({ nodes: starter.nodes, edges: starter.edges }), starter.nodes, starter.edges, { id: entry.id, connector: true }, starter.flows)!;
      expect(entry.focus).toEqual([...outage.connector!.from, ...outage.connector!.to]);
      expect(entry.questions).toBe(outage.notes.filter((note) => note.tone === 'question').length);
      expect(entry.flows.map((flow) => flow.id)).toEqual(outage.flows.filter((flow) => flow.state === 'breaks').map((flow) => flow.id));
      expect(entry.text).not.toMatch(INVENTED);
    }
    const publish = review.connectors.find((entry) => entry.id === 'publish');
    expect(publish).toMatchObject({ name: 'Producer Service → Domain Events', note: '8 shapes affected · 3 flows break' });
    expect(publish?.text).toMatch(/^If Producer Service can't reach Domain Events: 8 shapes are affected, and no one drawn waits on the result;/);
    // A severed dead-letter route changes no shape, and still breaks the flow drawn over it.
    expect(review.connectors.find((entry) => entry.id === 'dead-letter')?.text).toBe("If Integration Queue can't reach the dead-letter queue: Handle a failed delivery breaks. The drawing leaves 1 question open.");
  });
});

describe('outage walk — instances', () => {
  const nodes = [
    node('queue', 'queue', { text: 'Orders' }),
    node('producer', 'service', { text: 'Checkout' }),
    { ...node('worker', 'service', { text: 'Fulfilment', serviceKind: 'worker' }), replicas: 3 },
    node('db', 'database', { text: 'Orders DB' }),
  ];
  const edges = [
    edge('publish', 'producer', 'queue', { semantic: 'publishes' }),
    edge('consume', 'queue', 'worker', { semantic: 'consumes' }),
    edge('write', 'worker', 'db', { semantic: 'writes' }),
  ];

  it('loses one instance before it loses them all', () => {
    const one = walk(nodes, edges, 'worker');

    expect(one.instances).toEqual({ down: 1, of: 3 });
    expect(one.nodes.get('worker')).toBe('degraded');
    expect([...one.nodes.values()].filter((value) => value === 'unaffected')).toHaveLength(3);
    expect(one.edges.size).toBe(0);
    expect(one.notes).toHaveLength(1);
    expect(one.notes[0]).toMatchObject({ tone: 'shield', note: '2 of 3 still running' });
    expect(one.notes[0]?.text).toBe('Fulfilment is drawn with 3 instances, so the other 2 keep taking work from Orders. Nothing drawn says whether they can take all the work.');
  });

  it('says nothing of speed or room when one instance of several is down', () => {
    // Fed by a queue, and called: the two ways the note is worded.
    const called = [node('web', 'service', { text: 'Storefront' }), { ...node('api', 'service', { text: 'Catalog' }), replicas: 2 }, node('db', 'database', { text: 'Products' })];
    const calls = [edge('a', 'web', 'api', { semantic: 'calls' }), edge('b', 'api', 'db', { semantic: 'reads' })];
    const answering = walk(called, calls, 'api');
    expect(answering.notes[0]?.text).toBe('Catalog is drawn with 2 instances, so the other keeps answering. Nothing drawn says whether it can take all the work.');
    for (const outage of [walk(nodes, edges, 'worker'), answering]) {
      for (const line of outageSummary(outage)) expect(line).not.toMatch(INVENTED);
    }
  });

  it('takes every instance when asked, and never asks for more of something already replicated', () => {
    const all = walk(nodes, edges, { id: 'worker', whole: true });

    expect(all.instances).toBeUndefined();
    expect(all.headline).toMatch(/^All 3 Fulfilment instances are down\./);
    expect(all.nodes.get('queue')).toBe('holding');
    expect(all.notes.some((note) => note.id.startsWith('single:'))).toBe(false);
  });
});

describe('outage walk — what a shape is decides how it reads', () => {
  it('carries a failure up a synchronous chain to whoever started it', () => {
    const nodes = [
      node('shopper', 'actor', { text: 'Shopper' }),
      node('store', 'service', { text: 'Storefront' }),
      node('orders', 'service', { text: 'Orders' }),
      node('db', 'database', { text: 'Orders DB' }),
    ];
    const edges = [
      edge('a', 'shopper', 'store', { semantic: 'calls' }),
      edge('b', 'store', 'orders', { semantic: 'calls' }),
      edge('c', 'orders', 'db', { semantic: 'writes' }),
    ];
    const outage = walk(nodes, edges, 'db');

    expect(Object.fromEntries(outage.nodes)).toEqual({ db: 'down', orders: 'failing', store: 'failing', shopper: 'failing' });
    expect(outage.notes.map((note) => note.id)).toEqual(['no-fallback:orders', 'chain:store', 'people:shopper']);
    expect(outage.headline).toBe('Orders DB is down. Nothing drawn carries on without it.');
  });

  it('stops at a drawn fallback', () => {
    const nodes = [
      node('store', 'service', { text: 'Storefront' }),
      node('search', 'service', { text: 'Search' }),
      node('cached', 'database', { text: 'Cached results' }),
    ];
    const edges = [
      edge('a', 'store', 'search', { semantic: 'calls' }),
      edge('b', 'store', 'cached', { semantic: 'reads', kind: 'fallback' }),
    ];
    const outage = walk(nodes, edges, 'search');

    expect(outage.nodes.get('store')).toBe('degraded');
    expect(outage.nodes.get('cached')).toBe('catching');
    expect(outage.edges.get('b')).toBe('recovery');
    expect(outage.notes.map((note) => [note.tone, note.note])).toContainEqual(['shield', 'falls back to Cached results']);
  });

  it('reads a cache as something fallen through, not waited on', () => {
    const nodes = [
      node('shopper', 'actor', { text: 'Shopper' }),
      node('catalog', 'service', { text: 'Catalog' }),
      node('cache', 'database', { text: 'Product cache', databaseKind: 'cache', technology: 'Redis' }),
      node('db', 'database', { text: 'Products', databaseKind: 'sql' }),
    ];
    const edges = [
      edge('a', 'shopper', 'catalog', { semantic: 'calls' }),
      edge('b', 'catalog', 'cache', { semantic: 'reads' }),
      edge('c', 'catalog', 'db', { semantic: 'reads' }),
    ];
    const outage = walk(nodes, edges, 'cache');

    // The caller is degraded, and the failure does not travel on to the person.
    expect(outage.nodes.get('catalog')).toBe('degraded');
    expect(outage.nodes.get('shopper')).toBe('unaffected');
    expect(outage.notes[0]).toMatchObject({
      tone: 'question',
      note: 'every read falls to Products?',
      ask: 'Does Catalog fall through to Products when Product cache is down, and can Products take every read?',
    });
    expect(outage.notes[0]?.text).toMatch(/Redis saves snapshots to disk by default and reloads the last one when it restarts/);
  });

  it('marks a store stale when what writes it is gone but something still reads it', () => {
    const nodes = [
      node('shopper', 'actor', { text: 'Shopper' }),
      node('api', 'service', { text: 'Catalog API' }),
      node('events', 'queue', { text: 'Catalog events' }),
      node('producer', 'service', { text: 'Catalog admin' }),
      node('projector', 'service', { text: 'Projector', serviceKind: 'worker' }),
      node('read', 'database', { text: 'Read model' }),
    ];
    const edges = [
      edge('a', 'shopper', 'api', { semantic: 'calls' }),
      edge('b', 'api', 'read', { semantic: 'reads' }),
      edge('c', 'producer', 'events', { semantic: 'publishes' }),
      edge('d', 'events', 'projector', { semantic: 'consumes' }),
      edge('e', 'projector', 'read', { semantic: 'writes' }),
    ];
    const outage = walk(nodes, edges, 'projector');

    expect(outage.nodes.get('read')).toBe('stale');
    expect(outage.nodes.get('api')).toBe('unaffected');
    expect(outage.notes.find((note) => note.id === 'stale:read')).toMatchObject({ tone: 'effect', note: 'goes stale' });
  });

  it('lets another consumer keep draining a shared work queue', () => {
    const nodes = [
      node('producer', 'service', { text: 'Checkout' }),
      node('queue', 'queue', { text: 'Orders' }),
      node('one', 'service', { text: 'Packer', serviceKind: 'worker' }),
      node('two', 'service', { text: 'Second packer', serviceKind: 'worker' }),
    ];
    const edges = [
      edge('a', 'producer', 'queue', { semantic: 'publishes' }),
      edge('b', 'queue', 'one', { semantic: 'consumes' }),
      edge('c', 'queue', 'two', { semantic: 'consumes' }),
    ];
    const outage = walk(nodes, edges, 'one');

    expect(outage.nodes.get('queue')).toBe('unaffected');
    expect(outage.notes.map((note) => [note.tone, note.note])).toContainEqual(['shield', 'Second packer keeps draining it']);
  });

  it('keeps or drops a topic’s events according to the product it is drawn as', () => {
    const graph = (technology?: string) => {
      const nodes = [
        node('producer', 'service', { text: 'Checkout' }),
        node('topic', 'queue', { text: 'Order events', queueKind: 'topic', technology }),
        node('mailer', 'service', { text: 'Mailer' }),
      ];
      const edges = [edge('a', 'producer', 'topic', { semantic: 'publishes' }), edge('b', 'topic', 'mailer', { semantic: 'deliversTo' })];
      return walk(nodes, edges, 'mailer');
    };

    expect(graph().notes[0]).toMatchObject({ tone: 'question', note: 'keeps events for it, or drops them?' });
    expect(graph('Amazon SNS').notes[0]).toMatchObject({ tone: 'question', note: 'events are dropped meanwhile' });
    const kafka = graph('Kafka');
    expect(kafka.nodes.get('topic')).toBe('holding');
    expect(kafka.notes[0]?.text).toMatch(/Kafka keeps events for the topic's retention period/);
  });

  it('offers a dead-letter queue where a failing consumer has none', () => {
    const nodes = [
      node('producer', 'service', { text: 'Checkout' }),
      node('queue', 'queue', { text: 'Payments' }),
      node('worker', 'service', { text: 'Charger', serviceKind: 'worker' }),
      node('bank', 'service', { text: 'Bank', serviceKind: 'external' }),
    ];
    const edges = [
      edge('a', 'producer', 'queue', { semantic: 'publishes' }),
      edge('b', 'queue', 'worker', { semantic: 'consumes' }),
      edge('c', 'worker', 'bank', { semantic: 'calls' }),
      edge('d', 'worker', 'bank', { semantic: 'calls', kind: 'retry' }),
    ];
    const outage = walk(nodes, edges, 'bank');

    expect(outage.nodes.get('queue')).toBe('retrying');
    expect(outage.notes.find((note) => note.id === 'redelivers:queue')).toMatchObject({ tone: 'question', fix: { kind: 'dead-letter', queue: 'queue' } });
    expect(outage.notes.map((note) => note.note)).toContain('retries pile onto it');
  });

  it('says how many attempts a drawn dead-letter route allows', () => {
    const edges = starter.edges.map((item) => (item.id === 'dead-letter' ? { ...item, deliveryAttempts: 3 } : item));

    expect(walk(starter.nodes, edges, 'external').notes[1]?.note).toBe('dead-letters after 3 attempts');
  });

  it('takes everything inside a boundary down with it', () => {
    const nodes = [
      node('zone', 'group', { text: 'Zone A' }),
      node('shopper', 'actor', { text: 'Shopper' }),
      node('api', 'service', { text: 'API', parentId: 'zone' }),
      node('db', 'database', { text: 'Orders DB', parentId: 'zone' }),
      node('other', 'service', { text: 'Status page' }),
    ];
    const edges = [
      edge('a', 'shopper', 'api', { semantic: 'calls' }),
      edge('b', 'api', 'db', { semantic: 'writes' }),
      edge('c', 'shopper', 'other', { semantic: 'calls' }),
    ];
    const outage = walk(nodes, edges, 'zone');

    expect(lostBy(nodes, 'zone')).toEqual(['api', 'db']);
    expect(outage.lost).toEqual(['api', 'db']);
    expect(outage.nodes.get('shopper')).toBe('failing');
    expect(outage.nodes.get('other')).toBe('unaffected');
    expect(outage.headline).toBe('Everything in Zone A is down. Status page carries on.');
  });

  it('only takes down what runs', () => {
    const nodes = [node('shopper', 'actor', { text: 'Shopper' }), node('store', 'service', { text: 'Storefront' }), node('lonely', 'service', { text: 'Unwired' }), node('empty', 'group', { text: 'Empty' })];
    const edges = [edge('a', 'shopper', 'store', { semantic: 'calls' })];
    const analysis = analyzeTraffic({ nodes, edges });

    expect(canTakeDown(analysis, nodes, 'store')).toBe(true);
    expect(mayTakeDown(nodes, 'shopper')).toBe(false);
    expect(mayTakeDown(nodes, 'empty')).toBe(false);
    expect(mayTakeDown(nodes, 'lonely')).toBe(true);
    expect(outageOf(analysis, nodes, edges, { id: 'missing' })).toBeNull();
  });
});

describe('product facts', () => {
  it('matches only an assigned product name, with an optional version', () => {
    expect(outageFact({ type: 'queue', technology: 'Kafka 3.7' })?.name).toBe('Kafka');
    expect(outageFact({ type: 'queue', technology: 'aws sqs' })?.retains).toBe(true);
    expect(outageFact({ type: 'queue', technology: 'Kafka client' })).toBeNull();
    expect(outageFact({ type: 'service', technology: 'Kafka' })).toBeNull();
    expect(outageFact({ type: 'database', technology: undefined })).toBeNull();
    // The same rule a technology's kind follows: a parenthetical is about the product, a stack is not one.
    expect(outageFact({ type: 'queue', technology: 'Kafka (orders)' })?.name).toBe('Kafka');
    expect(outageFact({ type: 'queue', technology: 'Kafka + Redis' })).toBeNull();
  });

  it('knows which brokers keep what a subscriber missed, and which drop it', () => {
    for (const technology of ['Amazon MSK', 'Redpanda', 'Google Pub/Sub', 'Azure Service Bus', 'Apache Pulsar', 'Amazon Kinesis']) {
      expect(outageFact({ type: 'queue', technology })?.retains, technology).toBe(true);
    }
    for (const technology of ['Amazon EventBridge', 'Azure Event Grid', 'NATS', 'Mosquitto', 'Redis Pub/Sub']) {
      expect(outageFact({ type: 'queue', technology })?.retains, technology).toBe(false);
    }
    expect(outageFact({ type: 'database', technology: 'Valkey' })?.down).toMatch(/comes back empty/);
  });
});
