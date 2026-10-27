import { describe, expect, it, vi } from 'vitest';
import { compose } from '../../src/agent/compile';
import { schemaProblems, validateToolInput } from '../../src/agent/contract';
import { AgentError } from '../../src/agent/errors';
import { unknownFieldHint } from '../../src/agent/fields';
import * as vocabulary from '../../src/agent/vocabulary';
import { applyUpdate } from '../../src/agent/patch';
import { unreadableProposal } from '../../src/agent/proposal';
import { FULL_TOOLS } from '../../src/agent/schema';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

/**
 * Refusals an agent has to act on, from real Codex runs through Nodi whose `submit_proposal` calls
 * failed four to seven times before landing: each message must name the field that is wrong and what
 * to send instead, so one retry fixes it. Payloads are the recorded ones, trimmed.
 */

const proposal = FULL_TOOLS.find((tool) => tool.name === 'submit_proposal')!.inputSchema;
const submit = (ops: unknown[]) => ({ requestId: 'r', diagramId: 'd', expectedRevision: 'f:1', summary: 's', ops });
const long = 'Publish with the same event ID. On failure or uncertain confirmation, leave unsent and retry with backoff. A crash after publish but before sent-marking can duplicate delivery.';

it('does not run spelling-distance searches on oversized unknown field names', () => {
  const distance = vi.spyOn(vocabulary, 'distance');
  try {
    expect(unknownFieldHint('x'.repeat(1_000_000), ['about', 'context'])).toBe(' (takes about, context)');
    expect(distance).not.toHaveBeenCalled();
    expect(unknownFieldHint('contex', ['about', 'context'])).toBe('; use context (takes about, context)');
    expect(distance).toHaveBeenCalled();
  } finally {
    distance.mockRestore();
  }
});

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_guidance001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const outbox = () =>
  build({
    nodes: [
      { id: 'orders', type: 'service', label: 'Orders' },
      { id: 'postgres', type: 'database', label: 'PostgreSQL' },
    ],
    relationships: [{ id: 'insert', from: 'orders', to: 'postgres', label: 'Inserts order' }],
    flows: [{ id: 'place-order', title: 'Place order', steps: ['insert', { spotlight: ['orders'], caption: 'Return 202' }] }],
  });

function refusal(run: () => unknown): AgentError {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('schema refusals are reported against the op that was meant', () => {
  it('reads an add carrying malformed open points as an add, not as an arrange', () => {
    const ops = [{ op: 'add', openPoints: [{ id: 'risk-order-publish', elementId: 'orders', text: 'What recovers an inserted order if publishing fails?' }] }];
    // Was: "/ops/0/op: must be one of arrange", "/ops/0/openPoints: unknown field".
    expect(schemaProblems(proposal, submit(ops))).toEqual([
      '/ops/0/openPoints/0/elementId: unknown field; use about (takes id, kind, context, about)',
      '/ops/0/openPoints/0/text: unknown field; use context (takes id, kind, context, about)',
      '/ops/0/openPoints/0/kind: is required, must be one of tentative, awaiting, parked',
      '/ops/0/openPoints/0/about: is required',
    ]);
  });

  it('names the field a note or open point means when it is sent as target', () => {
    const ops = [{
      op: 'add',
      notes: [{ id: 'dlq-policy', target: 'order-events-dlq', text: 'Consumers ACK only after successful processing.' }],
      openPoints: [{ id: 'dlq-operations', target: 'order-events-dlq', text: 'Who monitors and triages this queue?' }],
    }];
    const problems = schemaProblems(proposal, submit(ops));
    expect(problems[0]).toBe('/ops/0/notes/0/target: unknown field; use about (takes id, text, kind, code, language, about, attach, near, style, color)');
    expect(problems).toContain('/ops/0/openPoints/0/target: unknown field; use about (takes id, kind, context, about)');
  });

  it('says a caption is too long instead of "must be string" for the step it is in', () => {
    // Was: "/ops/4/flows/0/steps/1: must be string" — the step's caption was over the limit.
    const ops = [
      { op: 'add', flows: [{ id: 'outbox-retry', title: 'Outbox retry', variantOf: 'place-order', steps: [{ relationship: 'outbox-claim', caption: 'Claim a pending event.' }, { relationship: 'publish', caption: long }] }] },
      { op: 'update', id: 'place-order', set: { steps: [{ frame: 'place-order.s1', spotlight: ['storefront', 'orders'], caption: 'Checkout submits a basket.' }, { spotlight: ['outbox-relay'], caption: long }] } },
    ];
    // The update was also read as an add before: "/ops/1/id: unknown field", "/ops/1/op: must be one of add".
    expect(schemaProblems(proposal, submit(ops))).toEqual([
      `/ops/0/flows/0/steps/1/caption: too long: at most 120 characters (got ${[...long].length})`,
      `/ops/1/set/steps/1/caption: too long: at most 120 characters (got ${[...long].length})`,
    ]);
  });

  it('lists the forms a step takes when it fits none of them', () => {
    const problems = schemaProblems(proposal, submit([{ op: 'update', id: 'place-order', set: { steps: [{ relationship: 'submit', text: 'Validate the order' }] } }]));
    expect(problems).toEqual([
      '/ops/0/set/steps/0: must be string, or {relationship, caption?, highlight?, pinnedView?}, or {spotlight, caption?}, or {frame, spotlight?, caption?, pinnedView?}',
      '/ops/0/set/steps/0/text: unknown field; use caption (takes relationship, caption, highlight, pinnedView)',
    ]);
  });

  it('lists the ops there are for an unknown or missing op', () => {
    expect(schemaProblems(proposal, submit([{ op: 'explode' }]))).toEqual(['/ops/0/op: must be one of add, update, remove, setLevel, arrange, moveInside, moveOutside']);
    expect(schemaProblems(proposal, submit([{ id: 'a', set: { label: 'x' } }]))).toEqual(['/ops/0/op: is required, must be one of add, update, remove, setLevel, arrange, moveInside, moveOutside']);
  });

  it('counts the problems in the refusal message when there is more than one', () => {
    const error = refusal(() => validateToolInput('submit_proposal', submit([{ op: 'add', openPoints: [{ elementId: 'orders' }] }])));
    expect(error.message).toMatch(/^3 problems; first — \/ops\/0\/openPoints\/0\/elementId: unknown field; use about/);
  });
});

describe('engine refusals say how to fix them', () => {
  it('names the later add for an id an earlier op refers to', () => {
    const ops = [
      { op: 'update', id: 'insert', set: { from: 'outbox-relay' } },
      { op: 'add', nodes: [{ id: 'outbox-relay', type: 'worker', label: 'Outbox relay' }] },
    ];
    expect(refusal(() => applyUpdate(outbox(), [], ops, undefined)).message).toBe(
      '/ops/0/set/from: no element "outbox-relay" in this view; /ops/1 adds it and ops run in order, so put that add before /ops/0',
    );
  });

  it('says which frame steps a flow has when an invented one is asked for', () => {
    const file = outbox();
    const frame = file.flows[0]!.steps.find((s) => !s.edgeId)!.id;
    const steps = ['insert', { frame: 'outbox.mark-sent', spotlight: ['postgres'], caption: 'Mark the row sent.' }];
    expect(refusal(() => applyUpdate(file, [], [{ op: 'update', id: 'place-order', set: { steps } }], undefined)).message).toBe(
      `/ops/0/set/steps/1/frame: no frame step "outbox.mark-sent" in this flow (its frame steps are "${frame}"); frame keeps an existing step, so for a new one drop frame and send {spotlight: [ids], caption?}`,
    );
  });

  it('tells a new flow to send a spotlight step instead of a frame', () => {
    const steps = ['insert', { frame: 'payments-dead-letter.reject', spotlight: ['orders'], caption: 'Reject with requeue=false.' }];
    expect(refusal(() => applyUpdate(outbox(), [], [{ op: 'add', flows: [{ id: 'dead-letter', title: 'Dead letter', steps }] }], undefined)).message).toBe(
      '/ops/0/flows/0/steps/1/frame: frame keeps a step a flow already has, and a new flow has none: drop frame and send {spotlight: [ids], caption?}',
    );
  });

  it('names the first unreadable problem and its fix in a proposal refusal', () => {
    const file = outbox();
    const crossed = unreadableProposal([
      { kind: 'label-crossed', ids: ['consume-notify', 'dead-letter-pay'], message: "connectors consume-notify and dead-letter-pay run through each other's caption." },
      { kind: 'shared-run', ids: ['route-pay', 'route-notify'], message: 'connectors route-pay and route-notify run on top of each other.' },
    ], file);
    // Was: "The proposal would leave unreadable content." with the problems only in details.
    expect(crossed.code).toBe('LAYOUT_CONSTRAINED');
    expect(crossed.message).toBe(
      'The proposal would leave unreadable content: connectors consume-notify and dead-letter-pay run through each other\'s caption (and 1 more). Shorten those connector labels, or add {"op":"arrange"} as the last op to re-lay them out.',
    );
    expect(crossed.details).toMatchObject({ suggestedOp: { op: 'arrange' } });
    const shared = unreadableProposal([{ kind: 'shared-run', ids: ['publish', 'outbox-claim'], message: 'connectors publish and outbox-claim run on top of each other.' }], file);
    expect(shared.message).toMatch(/run on top of each other\. Add \{"op":"arrange"\} as the last op to re-lay them out, or give one connector a route/);
  });
});
