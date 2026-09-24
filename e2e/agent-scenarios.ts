/**
 * The conversations `agent-conversations.ts` runs. Each one is what an agent following the tool
 * descriptions would send for a short chat with a person — not the most efficient script possible,
 * the ordinary one — with the checks that say whether the person ended up with what they asked for.
 */
import type { Scenario } from './agent-conversations';

type Json = Record<string, unknown>;

const n = (id: string, type: string, label: string, extra: Json = {}) => ({ id, type, label, ...extra });
const r = (id: string, from: string, to: string, label?: string, extra: Json = {}) => ({ id, from, to, ...(label ? { label } : {}), ...extra });

/** "Draw this architecture." */
export const ORDERS = (title: string): Json => ({
  title,
  nodes: [
    n('web', 'service', 'Web Storefront'),
    n('orders', 'api', 'Orders API', { technology: 'Spring Boot' }),
    n('ordersDb', 'sql-database', 'Orders DB', { technology: 'PostgreSQL 16' }),
    n('events', 'topic', 'order-events'),
    n('billingQ', 'queue', 'billing'),
    n('billing', 'worker', 'Billing Worker'),
    n('emailQ', 'queue', 'notifications'),
    n('email', 'worker', 'Email Worker'),
  ],
  relationships: [
    r('r1', 'web', 'orders', 'POST /orders'),
    r('r2', 'orders', 'ordersDb', 'Writes order'),
    r('r3', 'orders', 'events', 'Publishes OrderPlaced'),
    r('r4', 'events', 'billingQ'),
    r('r5', 'billingQ', 'billing'),
    r('r6', 'events', 'emailQ'),
    r('r7', 'emailQ', 'email'),
  ],
});

/** A platform of four teams' services — big enough that arranging it takes a visible moment. */
export const PLATFORM = (title: string, teamCount = 4, workers = 3): Json => {
  const teams = ['Checkout', 'Catalog', 'Fulfilment', 'Accounts', 'Payments', 'Search', 'Reviews', 'Loyalty'].slice(0, teamCount);
  const nodes: Json[] = [n('edge', 'gateway', 'Edge Gateway'), n('bus', 'topic', 'domain-events')];
  const relationships: Json[] = [];
  const groups = teams.map((team) => ({ id: team.toLowerCase(), label: `${team} team`, kind: 'boundary' }));
  teams.forEach((team, t) => {
    const g = team.toLowerCase();
    const api = `${g}-api`;
    nodes.push(n(api, 'api', `${team} API`, { group: g, technology: 'Kotlin' }), n(`${g}-db`, 'sql-database', `${team} DB`, { group: g }));
    relationships.push(r(`${g}-in`, 'edge', api, `Routes /${g}`), r(`${g}-store`, api, `${g}-db`, 'Reads and writes'), r(`${g}-pub`, api, 'bus', `Publishes ${team}Changed`));
    for (let w = 1; w <= workers; w += 1) {
      const q = `${g}-q${w}`;
      const worker = `${g}-w${w}`;
      nodes.push(n(q, 'queue', `${g}-jobs-${w}`, { group: g }), n(worker, 'worker', `${team} Worker ${w}`, { group: g }));
      relationships.push(r(`${q}-in`, api, q), r(`${q}-out`, q, worker));
    }
    void t;
  });
  return { title, groups, nodes, relationships };
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export const SCENARIOS: Record<string, Scenario> = {
  /**
   * The chat the integration exists for, as an agent reading today's descriptions would run it:
   * create once, then four follow-ups — never told "update the existing diagram".
   */
  async chain(ctx) {
    const agent = await ctx.session('agent');
    const created = await agent.call('create_diagram', ORDERS(`Orders ${Date.now()}`));
    ctx.expect(created.ok, 'create succeeds');
    const id = str(created.value.diagramId);
    let revision = str(created.value.revision);
    ctx.log('create', created.value);

    // "Add a dead-letter queue for billing and explain the retry behaviour in a note."
    const dlq = {
      diagramId: id,
      expectedRevision: revision,
      ops: [
        {
          op: 'add',
          nodes: [n('billingDlq', 'dead-letter-queue', 'billing-dlq')],
          relationships: [r('r8', 'billingQ', 'billingDlq', 'After 5 failed attempts', { kind: 'failure' })],
          notes: [{ id: 'retryNote', text: 'Billing retries 5 times with exponential backoff (1s → 16s), then parks the message in billing-dlq for a person to replay.', near: 'billingDlq' }],
        },
      ],
    };
    let step = await agent.call('update_diagram', dlq);
    ctx.log('update:dlq', step.value);
    if (!step.ok && (step.record.code === 'NOT_ACTIVE' || step.record.code === 'REVISION_CONFLICT')) {
      // The recovery an agent has to discover from the hint.
      const read = await agent.call('read_diagram', { diagramId: id });
      revision = str(read.value.revision) ?? revision;
      step = await agent.call('update_diagram', { ...dlq, expectedRevision: revision, activate: true });
      ctx.log('update:dlq:retry', step.value);
    }
    ctx.expect(step.ok, 'adding the DLQ and note updates the same diagram');
    revision = str(step.value.revision) ?? revision;

    // "Add a flow for the normal processing path."
    step = await agent.call('update_diagram', {
      diagramId: id,
      expectedRevision: revision,
      ops: [{ op: 'add', flows: [{ id: 'happy', title: 'Normal processing', steps: ['r1', 'r2', 'r3', 'r4', 'r5'] }] }],
    });
    ctx.log('update:flow', step.value);
    ctx.expect(step.ok, 'adding the flow updates the same diagram');
    revision = str(step.value.revision) ?? revision;

    // "Rename the billing worker to Invoicing Worker."
    step = await agent.call('update_diagram', { diagramId: id, expectedRevision: revision, ops: [{ op: 'update', id: 'billing', set: { label: 'Invoicing Worker' } }] });
    ctx.log('update:rename', step.value);
    ctx.expect(step.ok, 'renaming updates the same diagram');
    revision = str(step.value.revision) ?? revision;

    // "Clean up the arrows and spacing."
    step = await agent.call('update_diagram', { diagramId: id, expectedRevision: revision, ops: [{ op: 'arrange' }] });
    ctx.log('update:arrange', step.value);
    ctx.expect(step.ok, 'cleanup arranges the same diagram');

    const final = await agent.call('read_diagram', { diagramId: id });
    const elements = (final.value.elements as { id: string; label: string }[] | undefined) ?? [];
    ctx.expect(elements.some((e) => e.id === 'billingDlq'), 'the DLQ is there');
    ctx.expect(elements.some((e) => e.id === 'billing' && e.label === 'Invoicing Worker'), 'the rename stuck, same id');
    ctx.expect(((final.value.flows as unknown[]) ?? []).length === 1, 'exactly one flow');
    ctx.expect(((final.value.notes as unknown[]) ?? []).length === 1, 'exactly one note');
  },

  /**
   * The person opens a different diagram between two turns; the agent's follow-up is still about the
   * one it made. It must land there — without switching what the person is looking at.
   */
  async switch(ctx) {
    const agent = await ctx.session('agent');
    const stamp = Date.now();
    const a = await agent.call('create_diagram', { ...ORDERS(`Switch A ${stamp}`), open: true });
    const b = await agent.call('create_diagram', { title: `Switch B ${stamp}`, nodes: [n('x', 'service', 'Other')] });
    ctx.expect(a.ok && b.ok, 'both creates succeed');
    // A follow-up while A is open, so the agent holds A's latest revision.
    const first = await agent.call('update_diagram', { diagramId: a.value.diagramId, expectedRevision: a.value.revision, ops: [{ op: 'update', id: 'web', set: { label: 'Storefront' } }] });
    ctx.expect(first.ok, 'the first follow-up applies');
    // The person opens B.
    await ctx.openInApp(String(b.value.path));
    const listed = await agent.call('list_diagrams', {});
    const open = ((listed.value.diagrams as { diagramId: string; open: boolean }[]) ?? []).find((d) => d.open);
    ctx.log('open after switch', open?.diagramId);
    ctx.expect(open?.diagramId === b.value.diagramId, 'B is open after the person switched');
    // The follow-up about A, with the revision the agent was last given.
    const followUp = await agent.call('update_diagram', {
      diagramId: a.value.diagramId,
      expectedRevision: first.value.revision,
      ops: [{ op: 'add', notes: [{ id: 'n1', text: 'Storefront is the only public entry point.', near: 'web' }] }],
    });
    ctx.log('follow-up', followUp.value);
    ctx.expect(followUp.ok, 'the follow-up about A applies to A');
    const after = await agent.call('list_diagrams', {});
    const stillOpen = ((after.value.diagrams as { diagramId: string; open: boolean }[]) ?? []).find((d) => d.open);
    ctx.expect(stillOpen?.diagramId === b.value.diagramId, 'B is still what the person sees');
  },

  /**
   * A diagram big enough to take a moment, made with open: true, for the person to watch: the stages
   * arrive as MCP progress, the diagram is written once and opened, and the receipt says so.
   */
  async watch(ctx) {
    const agent = await ctx.session('agent');
    const teams = Number(process.env.WATCH_TEAMS ?? 4);
    const workers = Number(process.env.WATCH_WORKERS ?? 3);
    const created = await agent.call('create_diagram', { ...PLATFORM(`Platform ${Date.now()}`, teams, workers), open: true });
    ctx.log('receipt', created.value);
    ctx.log('progress', created.record.progress);
    ctx.expect(created.ok, 'the platform diagram is created');
    ctx.expect(created.value.opened === true, 'and opened, since the person asked to see it');
    ctx.expect(created.record.progress.length >= 2, 'the agent heard at least two stages');
  },

  /**
   * A change to the diagram on screen that takes a moment (a whole-view arrange of a platform): the
   * person sees it proposed over the diagram, then committed as one undo step.
   */
  async watchUpdate(ctx) {
    const agent = await ctx.session('agent');
    const created = await agent.call('create_diagram', { ...PLATFORM(`Platform edit ${Date.now()}`, 4, 3), open: true });
    ctx.expect(created.ok, 'the platform diagram is created and opened');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const updated = await agent.call('update_diagram', {
      diagramId: created.value.diagramId,
      expectedRevision: created.value.revision,
      ops: [
        { op: 'add', nodes: [n('dlq', 'dead-letter-queue', 'checkout-dlq', { group: 'checkout' })], relationships: [r('dlq-in', 'checkout-q1', 'dlq', 'After 5 attempts', { kind: 'failure' })] },
        { op: 'arrange', spacing: 'spacious' },
      ],
    });
    ctx.log('update', updated.value);
    ctx.log('progress', updated.record.progress);
    ctx.expect(updated.ok, 'the change applies to the same diagram');
  },

  /**
   * "Update the Payments diagram" when two diagrams are called that: the lookup names both, exactly, so
   * the agent asks; nothing is changed until it knows which.
   */
  async ambiguous(ctx) {
    const agent = await ctx.session('agent');
    const title = `Payments ${Date.now()}`;
    const a = await agent.call('create_diagram', ORDERS(title));
    const b = await agent.call('create_diagram', { ...ORDERS(title), allowDuplicateTitle: true });
    ctx.expect(a.ok && b.ok, 'two diagrams share a title');
    const before = [await agent.call('read_diagram', { diagramId: a.value.diagramId }), await agent.call('read_diagram', { diagramId: b.value.diagramId })].map((r) => r.value.revision);
    const found = await agent.call('list_diagrams', { query: title });
    const exact = ((found.value.diagrams as { diagramId: string; exact?: boolean }[]) ?? []).filter((d) => d.exact);
    ctx.log('candidates', exact);
    ctx.expect(exact.length === 2, 'the lookup returns both, marked exact — the agent has to ask');
    const after = [await agent.call('read_diagram', { diagramId: a.value.diagramId }), await agent.call('read_diagram', { diagramId: b.value.diagramId })].map((r) => r.value.revision);
    ctx.expect(JSON.stringify(before) === JSON.stringify(after), 'neither changed while the target was unresolved');
  },

  /** Two agents, two diagrams: each session's own history, never the other's. */
  async twoSessions(ctx) {
    const one = await ctx.session('one');
    const two = await ctx.session('two');
    const stamp = Date.now();
    const a = await one.call('create_diagram', ORDERS(`Session one ${stamp}`));
    const b = await two.call('create_diagram', ORDERS(`Session two ${stamp}`));
    const [listOne, listTwo] = await Promise.all([one.call('list_diagrams', {}), two.call('list_diagrams', {})]);
    const mine = (list: Record<string, unknown>) => ((list.thisSession as { diagramId: string }[]) ?? []).map((d) => d.diagramId);
    ctx.log('sessions', { one: mine(listOne.value), two: mine(listTwo.value) });
    ctx.expect(mine(listOne.value).includes(String(a.value.diagramId)) && !mine(listOne.value).includes(String(b.value.diagramId)), 'session one sees only its diagram');
    ctx.expect(mine(listTwo.value).includes(String(b.value.diagramId)) && !mine(listTwo.value).includes(String(a.value.diagramId)), 'session two sees only its diagram');
  },

  /** A stale revision is a conflict to resolve, and a vanished diagram is reported — never a new file. */
  async staleAndGone(ctx) {
    const agent = await ctx.session('agent');
    const created = await agent.call('create_diagram', ORDERS(`Stale ${Date.now()}`));
    const first = await agent.call('update_diagram', { diagramId: created.value.diagramId, expectedRevision: created.value.revision, ops: [{ op: 'update', id: 'web', set: { label: 'Storefront' } }] });
    ctx.expect(first.ok, 'a first follow-up applies');
    const stale = await agent.call('update_diagram', { diagramId: created.value.diagramId, expectedRevision: created.value.revision, ops: [{ op: 'update', id: 'web', set: { label: 'Shop' } }] });
    ctx.log('stale', stale.value);
    ctx.expect(stale.record.code === 'REVISION_CONFLICT' && (stale.value.error as { details?: { currentRevision?: string } }).details?.currentRevision === first.value.revision, 'the old revision is refused, naming the current one');
    const gone = await agent.call('update_diagram', { diagramId: 'd_doesnotexist', expectedRevision: 'f:0', ops: [{ op: 'update', id: 'web', set: { label: 'x' } }] });
    ctx.log('gone', gone.value);
    ctx.expect(gone.record.code === 'NOT_FOUND', 'a diagram that is gone is reported as gone');
  },

  /** A retry after a lost answer returns the first answer: one note, not two. */
  async replay(ctx) {
    const agent = await ctx.session('agent');
    const created = await agent.call('create_diagram', ORDERS(`Replay ${Date.now()}`));
    const change = { requestId: `replay-${Date.now()}`, diagramId: created.value.diagramId, expectedRevision: created.value.revision, ops: [{ op: 'add', notes: [{ id: 'n1', text: 'Idempotent by order id.', about: 'orders' }] }] };
    const first = await agent.call('update_diagram', change);
    const again = await agent.call('update_diagram', change);
    ctx.log('again', again.value);
    ctx.expect(first.ok && again.ok && again.value.replayed === true, 'the retry is answered from the first');
    const read = await agent.call('read_diagram', { diagramId: created.value.diagramId });
    ctx.expect(((read.value.notes as unknown[]) ?? []).length === 1, 'exactly one note');
  },

  /** Notes and flows as the person refines them: stable ids, edits in place, order kept. */
  async notesFlows(ctx) {
    const agent = await ctx.session('agent');
    const created = await agent.call('create_diagram', {
      ...ORDERS(`Notes ${Date.now()}`),
      notes: [{ id: 'why', text: 'Assumption: billing retries 5 times.', kind: 'question', about: 'billing' }],
      flows: [{ id: 'main', title: 'Normal processing', steps: ['r1', 'r3', 'r4', 'r5'] }],
      layout: { primaryFlow: 'main' },
    });
    ctx.expect(created.ok, 'created with a note and a main flow in one call');
    let rev = created.value.revision;
    const edit = await agent.call('update_diagram', {
      diagramId: created.value.diagramId,
      expectedRevision: rev,
      ops: [
        { op: 'update', id: 'why', set: { text: 'Billing retries 5 times with backoff, then parks in the DLQ.', kind: 'decision' } },
        { op: 'add', notes: [{ id: 'sig', text: 'Signed with HMAC.', about: 'r1' }] },
        { op: 'update', id: 'main', set: { steps: ['r1', 'r3', 'r6', 'r7'] } },
        { op: 'add', flows: [{ id: 'billingFlow', title: 'Billing', steps: ['r4', 'r5'] }] },
      ],
    });
    ctx.log('edit', edit.value);
    ctx.expect(edit.ok, 'note, attachment and flows changed in one request');
    rev = edit.value.revision;
    const dup = await agent.call('update_diagram', { diagramId: created.value.diagramId, expectedRevision: rev, ops: [{ op: 'add', flows: [{ id: 'main2', title: 'Normal processing', steps: ['r1'] }] }] });
    ctx.expect(dup.record.code === 'DUPLICATE_FLOW', 'a second flow of the same name is refused, naming the one to update');
    const read = await agent.call('read_diagram', { diagramId: created.value.diagramId, focus: { nodes: ['web', 'orders'] } });
    ctx.log('read', { notes: read.value.notes, flows: read.value.flows, relationships: read.value.relationships });
    const flows = (read.value.flows as { id: string; steps: unknown[] }[]) ?? [];
    ctx.expect(flows.map((f) => f.id).join() === 'main,billingFlow', 'both flows, in order');
    ctx.expect(JSON.stringify(flows[0]?.steps) === JSON.stringify(['r1', 'r3', 'r6', 'r7']), 'the main flow has the revised order');
  },

  /** "The current diagram" is what the person has open — told apart from what this session made. */
  async current(ctx) {
    const agent = await ctx.session('agent');
    const stamp = Date.now();
    const a = await agent.call('create_diagram', ORDERS(`Current A ${stamp}`));
    const b = await agent.call('create_diagram', ORDERS(`Current B ${stamp}`));
    await ctx.openInApp(String(b.value.path));
    const listed = await agent.call('list_diagrams', {});
    const active = listed.value.active as { diagramId?: string; revision?: string; view?: unknown } | null;
    const session = (listed.value.thisSession as { diagramId: string }[]) ?? [];
    ctx.log('active', active);
    ctx.expect(active?.diagramId === b.value.diagramId && typeof active?.revision === 'string', '"the current diagram" is the one open, with a revision to pass');
    ctx.expect(session[0]?.diagramId === b.value.diagramId && session.some((d) => d.diagramId === a.value.diagramId), 'the session remembers both it made, most recent first');
  },

  /** A second "create" with the same title is almost always a follow-up the agent mistook. */
  async duplicate(ctx) {
    const agent = await ctx.session('agent');
    const title = `Dup ${Date.now()}`;
    const first = await agent.call('create_diagram', ORDERS(title));
    const second = await agent.call('create_diagram', ORDERS(title));
    ctx.log('second', second.value);
    ctx.expect(first.ok, 'the first create succeeds');
    ctx.expect(!second.ok && second.record.code === 'DUPLICATE_TITLE', 'the second is refused with the existing diagram named');
    const third = await agent.call('create_diagram', { ...ORDERS(title), allowDuplicateTitle: true });
    ctx.expect(third.ok, 'an explicit separate diagram with the same title is still possible');
  },
};
