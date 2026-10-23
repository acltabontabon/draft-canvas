import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import skillExample from '../../skills/draft-canvas/references/example-create.json';

/**
 * A create receipt's legibility covers every view, not just the top one: an inside view (the next C4
 * level) that crosses itself is the agent's to fix too, and without its numbers the agent could only
 * find out by rendering each view.
 */

type Legibility = { crossings: number; fill: number; detours?: string[]; views?: (Legibility & { view: string[] })[] };
const receiptOf = (request: Record<string, unknown>) => compose(request, 'd_viewlegib01').receipt as { legibility: Legibility; advisories?: string[] };

/** Every service on the left calls every one on the right: a complete bipartite graph, which no
 *  layout can draw without crossings once it has three on each side. */
function tangle(prefix: string, size: number) {
  const left = Array.from({ length: size }, (_, i) => ({ id: `${prefix}l${i}`, type: 'service', label: `Caller ${i + 1}` }));
  const right = Array.from({ length: size }, (_, i) => ({ id: `${prefix}r${i}`, type: 'service', label: `Callee ${i + 1}` }));
  const relationships = left.flatMap((l, i) => right.map((r, j) => ({ id: `${prefix}e${i}${j}`, from: l.id, to: r.id, label: 'Calls' })));
  return { nodes: [...left, ...right], relationships };
}

// Three a side is the smallest tangle that must cross: at four, repairing it took seconds per test and
// timed out on CI's coverage run.
describe('create receipt legibility', () => {
  it('has no views when there is no inside view', () => {
    const { legibility } = receiptOf({
      requestId: 'v1',
      title: 'Flat',
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'b', type: 'database', label: 'B' },
      ],
      relationships: [{ id: 'ab', from: 'a', to: 'b', label: 'Writes' }],
    });
    expect(legibility.crossings).toBe(0);
    expect(legibility).not.toHaveProperty('views');
  });

  it('reports every inside view by the ids leading down to it, depth first', () => {
    const { legibility } = receiptOf(skillExample as Record<string, unknown>);
    expect(legibility.views?.map((v) => v.view)).toEqual([['storefront'], ['storefront', 'orders']]);
    // The skill teaches by this example, so every view of it reads cleanly.
    for (const view of [legibility, ...(legibility.views ?? [])]) expect(view.crossings).toBe(0);
  });

  it('says how much an inside view crosses itself, and advises about that view by name', () => {
    const { legibility, advisories } = receiptOf({
      requestId: 'v3',
      title: 'Tangled inside',
      layout: { allowDegraded: true },
      nodes: [
        { id: 'user', type: 'person', label: 'User' },
        { id: 'sys', type: 'service', label: 'System', inside: { level: 'container', ...tangle('t', 3) } },
      ],
      relationships: [{ id: 'uses', from: 'user', to: 'sys', label: 'Uses' }],
    });
    // The top view is two shapes and a line; the trouble is all one level down.
    expect(legibility.crossings).toBe(0);
    const inside = legibility.views?.find((v) => v.view.join('/') === 'sys');
    expect(inside?.crossings).toBeGreaterThanOrEqual(6);
    expect(advisories?.some((a) => a.startsWith('Inside sys: The arrangement has'))).toBe(true);
    // Without a flow of its own, naming its main path is the advice.
    expect(advisories?.find((a) => a.startsWith('Inside sys:'))).toContain('name the main path as a flow');
  });

  it('does not ask an inside view for the main flow it was already laid out around', () => {
    const inner = tangle('t', 3);
    const { advisories } = receiptOf({
      requestId: 'v4',
      title: 'Tangled inside, with its path',
      layout: { allowDegraded: true },
      nodes: [
        { id: 'user', type: 'person', label: 'User' },
        {
          id: 'sys',
          type: 'service',
          label: 'System',
          inside: { level: 'container', ...inner, flows: [{ id: 'main', title: 'Main', steps: ['te00', 'te11'] }] },
        },
      ],
      relationships: [{ id: 'uses', from: 'user', to: 'sys', label: 'Uses' }],
    });
    const inside = advisories?.find((a) => a.startsWith('Inside sys: The arrangement has'));
    expect(inside).toBeDefined();
    expect(inside).not.toContain('name the main path');
  });
});
