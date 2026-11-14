import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addEdges, addNodes } from '../../src/document/operations';
import { planArrange, planTidy, reuseOf } from '../../src/agent/layoutPlan';
import { __resetOffThread, cancelled, runOffThread } from '../../src/agent/offThread';
import { charge, pastDeadline, withBudget, withinWork, workLeft } from '../../src/agent/route';

/**
 * What Arrange and Tidy up work out before showing a preview (`agent/layoutPlan.ts`), and the budget
 * and thread they run under. The editor-level behaviour is in `tests/arrange.test.ts` and `tidy.test.ts`.
 */

function room() {
  const a = createNode({ id: 'a', type: 'service', x: 100, y: 100, text: 'Orders API' });
  const b = createNode({ id: 'b', type: 'database', x: 100, y: 100, text: 'Orders DB' });
  const c = createNode({ id: 'c', type: 'queue', x: 100, y: 100, text: 'Orders' });
  return addEdges(addNodes(createDocument('Plan'), [a, b, c]), [createEdge({ id: 'ab', source: 'a', target: 'b' }), createEdge({ id: 'ac', source: 'a', target: 'c' })]);
}

describe('the work budget', () => {
  it('counts what is charged, gates on it, and says it was cut short', () => {
    const run = withBudget({ work: 10 }, () => {
      expect(workLeft()).toBe(10);
      charge(4);
      expect(pastDeadline()).toBe(false);
      charge(7);
      expect(workLeft()).toBe(-1);
      return pastDeadline();
    });
    expect(run).toEqual({ value: true, used: 11, partial: true });
    // Nothing is cut short, and nothing leaks out of a finished run.
    expect(withBudget({ work: 10 }, () => charge(3)).partial).toBe(false);
    expect(workLeft()).toBe(Number.POSITIVE_INFINITY);
    expect(pastDeadline()).toBe(false);
  });

  it('splits a budget between parts, and a spent slice leaves the rest alone', () => {
    const run = withBudget({ work: 100 }, () => {
      withinWork(30, () => {
        charge(31);
        expect(pastDeadline()).toBe(true);
      });
      // The slice ended; the budget as a whole did not.
      expect(workLeft()).toBe(69);
      return pastDeadline();
    });
    expect(run.value).toBe(false);
  });
});

describe('planArrange', () => {
  it('offers both directions for a small room, shown first on the suggested one', () => {
    const result = planArrange(room());
    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') return;
    expect(Object.keys(result.plan.options).sort()).toEqual(['down', 'right']);
    expect(result.plan.alternativeSkipped).toBe(false);
    expect(result.plan.options[result.plan.direction]).toBeDefined();
  });

  it('keeps a direction a layout skill asked for, and offers no other', () => {
    const result = planArrange(room(), { preset: { direction: 'down' } });
    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') return;
    expect(Object.keys(result.plan.options)).toEqual(['down']);
  });

  it('refuses nothing about a room with nothing to lay out', () => {
    const note = createNode({ id: 'n', type: 'note', x: 0, y: 0, text: 'Just a note' });
    expect(planArrange(addNodes(createDocument('Notes'), [note])).kind).toBe('unchanged');
  });
});

describe('planTidy', () => {
  it('says nothing to tidy, and what reads badly all the same, for a room that is tidy', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ id: 'b', type: 'service', x: 420, y: 0, text: 'B' });
    const tidy = addEdges(addNodes(createDocument('Tidy'), [a, b]), [createEdge({ id: 'ab', source: 'a', target: 'b' })]);
    const result = planTidy(tidy);
    expect(result).toMatchObject({ kind: 'unchanged', partial: false });
  });
});

describe('reuseOf', () => {
  it('keeps every node and connector that came back equal as the very same object', () => {
    const base = room();
    // What another thread hands back: a copy, with one shape moved.
    const copy = structuredClone(base);
    copy.nodes[1]!.x = 400;
    const view = reuseOf(base, copy);
    expect(view.nodes[0]).toBe(base.nodes[0]);
    expect(view.nodes[1]).not.toBe(base.nodes[1]);
    expect(view.nodes[1]!.x).toBe(400);
    expect(view.nodes[2]).toBe(base.nodes[2]);
    expect(view.edges).toBe(base.edges);
  });

  it('is the base itself when nothing differs', () => {
    const base = room();
    expect(reuseOf(base, structuredClone(base))).toBe(base);
  });
});

describe('running a layout job', () => {
  it('rejects with a cancel, and keeps nothing, when its signal aborts', async () => {
    __resetOffThread();
    const controller = new AbortController();
    const pending = runOffThread({ kind: 'tidy', doc: room() }, undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: cancelled().name });
  });

  it('never starts a job whose signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runOffThread({ kind: 'arrange', doc: room() }, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
