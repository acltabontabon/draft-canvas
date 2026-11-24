import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftEdge, DraftNode } from '../src/document/types';
import { isWalkId, tellNext, walkOfDiagram, walkOfSelection, walkToPresent } from '../src/presentation/walk';

/**
 * A walk is the flow Present tells when nobody has made one: the diagram's own connectors, in the
 * order their arrows point. These pin that order, what a selection asks for, and when a selection
 * is too little to speak for Present.
 */
function graph(shapes: Record<string, [number, number]>, links: string[]) {
  const nodes: DraftNode[] = Object.entries(shapes).map(([id, [x, y]]) => ({ ...createNode({ type: 'service', x, y, text: id }), id }));
  const edges: DraftEdge[] = links.map((link) => {
    const [source, target] = link.split('>') as [string, string];
    return { ...createEdge({ source, target }), id: link };
  });
  return { nodes, edges };
}

const told = (walk: ReturnType<typeof walkOfDiagram>) =>
  walk?.flow.steps.map((step) => [step.edgeId, ...(step.extraEdgeIds ?? [])].join('+'));

const NONE = { nodes: [], edges: [] };

describe('walkOfDiagram', () => {
  it('follows one path to its end before picking up the next branch', () => {
    const doc = graph(
      { web: [0, 0], api: [200, 0], db: [400, 0], cache: [400, 200], audit: [600, 200] },
      ['api>cache', 'cache>audit', 'web>api', 'api>db'],
    );
    // `api>db` is a dead end told where it sits; `api>cache` goes on to `audit` before anything else.
    expect(told(walkOfDiagram(doc))).toEqual(['web>api', 'api>db', 'api>cache', 'cache>audit']);
  });

  it('tells a fan-out to dead ends as one step', () => {
    const doc = graph({ gw: [0, 0], a: [200, -100], b: [200, 0], c: [200, 100] }, ['gw>c', 'gw>a', 'gw>b']);
    expect(told(walkOfDiagram(doc))).toEqual(['gw>a+gw>b+gw>c']);
  });

  it('tells lone sources that share a target as one step', () => {
    const doc = graph({ p1: [0, 0], p2: [0, 100], topic: [200, 50], worker: [400, 50] }, ['p2>topic', 'p1>topic', 'topic>worker']);
    expect(told(walkOfDiagram(doc))).toEqual(['p1>topic+p2>topic', 'topic>worker']);
  });

  it('tells every connector of a loop once, starting top-left', () => {
    const doc = graph({ a: [0, 0], b: [200, 0], c: [200, 200] }, ['c>a', 'b>c', 'a>b']);
    expect(told(walkOfDiagram(doc))).toEqual(['a>b', 'b>c', 'c>a']);
  });

  it('skips connectors with a missing end, and gives nothing without connectors', () => {
    expect(walkOfDiagram(graph({ a: [0, 0], b: [200, 0] }, []))).toBeNull();
    expect(told(walkOfDiagram(graph({ a: [0, 0], b: [200, 0] }, ['a>b', 'a>gone'])))).toEqual(['a>b']);
  });

  it('is a flow the file does not hold, the same every time', () => {
    const doc = graph({ a: [0, 0], b: [200, 0], c: [400, 0] }, ['a>b', 'b>c']);
    const walk = walkOfDiagram(doc)!;
    expect(isWalkId(walk.flow.id)).toBe(true);
    expect(walk.flow.title).toBe('Whole diagram');
    expect(walkOfDiagram(doc)).toEqual(walk);
  });

  it('survives a chain longer than the call stack would', () => {
    const shapes: Record<string, [number, number]> = {};
    const links: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      shapes[`n${i}`] = [i * 10, 0];
      if (i > 0) links.push(`n${i - 1}>n${i}`);
    }
    expect(walkOfDiagram(graph(shapes, links))!.flow.steps.length).toBe(200);
  });
});

describe('walkOfSelection', () => {
  const doc = graph(
    { web: [0, 0], api: [200, 0], db: [400, 0], queue: [200, 200], worker: [400, 200], mail: [600, 200] },
    ['web>api', 'api>db', 'api>queue', 'queue>worker', 'worker>mail'],
  );

  it('walks on from one shape', () => {
    const walk = walkOfSelection(doc, { nodes: ['queue'], edges: [] })!;
    expect(told(walk)).toEqual(['queue>worker', 'worker>mail']);
    expect(walk.flow.title).toBe('From queue');
    expect(walk.about).toBe('selection');
  });

  it('walks the way between two shapes, whichever was picked first', () => {
    const walk = walkOfSelection(doc, { nodes: ['mail', 'web'], edges: [] })!;
    expect(told(walk)).toEqual(['web>api', 'api>queue', 'queue>worker', 'worker>mail']);
    expect(walk.flow.title).toBe('web to mail');
  });

  it('walks the connectors among several shapes, and the selected connectors', () => {
    expect(told(walkOfSelection(doc, { nodes: ['api', 'queue', 'worker'], edges: [] }))).toEqual(['api>queue', 'queue>worker']);
    const picked = walkOfSelection(doc, { nodes: [], edges: ['worker>mail', 'web>api'] })!;
    expect(told(picked)).toEqual(['web>api', 'worker>mail']);
    expect(picked.flow.title).toBe('Selection');
  });

  it('takes a boundary to mean what is inside it', () => {
    const inside = graph({ a: [0, 0], b: [200, 0], c: [400, 0], out: [600, 0] }, ['a>b', 'b>c', 'c>out']);
    const boundary = { ...createNode({ type: 'group', x: -20, y: -20 }), id: 'g' };
    const nodes = [boundary, ...inside.nodes.map((node) => (node.id === 'out' ? node : { ...node, parentId: 'g' }))];
    expect(told(walkOfSelection({ nodes, edges: inside.edges }, { nodes: ['g'], edges: [] }))).toEqual(['a>b', 'b>c']);
  });

  it('asks for nothing when everything is selected: that is the whole diagram, not a part of it', () => {
    expect(walkOfSelection(doc, { nodes: doc.nodes.map((node) => node.id), edges: [] })).toBeNull();
    expect(walkOfSelection(doc, { nodes: [], edges: doc.edges.map((edge) => edge.id) })).toBeNull();
  });

  it('asks for nothing when it makes less than two steps', () => {
    expect(walkOfSelection(doc, NONE)).toBeNull();
    expect(walkOfSelection(doc, { nodes: ['mail'], edges: [] })).toBeNull();
    expect(walkOfSelection(doc, { nodes: [], edges: ['web>api'] })).toBeNull();
    expect(walkOfSelection(doc, { nodes: ['worker'], edges: [] })).toBeNull();
  });
});

describe('walkToPresent', () => {
  const doc = graph({ a: [0, 0], b: [200, 0], c: [400, 0] }, ['a>b', 'b>c']);

  it('prefers a selection that makes a story, then a saved flow, then the whole diagram', () => {
    expect(walkToPresent(doc, { nodes: ['a'], edges: [] }, true)?.about).toBe('selection');
    expect(walkToPresent(doc, { nodes: ['c'], edges: [] }, true)).toBeNull();
    expect(walkToPresent(doc, NONE, true)).toBeNull();
    expect(walkToPresent(doc, NONE, false)?.about).toBe('diagram');
  });
});

describe('tellNext', () => {
  const doc = graph({ a: [0, 0], b: [200, 0], c: [400, 0], d: [400, 200], e: [600, 200] }, ['a>b', 'b>c', 'b>d', 'd>e']);
  const live = new Set(doc.edges.map((edge) => edge.id));
  const walk = walkOfDiagram(doc)!.flow;
  const order = (flow: typeof walk) => flow.steps.map((step) => step.edgeId);

  it('starts from the derived order', () => {
    expect(order(walk)).toEqual(['a>b', 'b>c', 'b>d', 'd>e']);
  });

  it('brings a connector still to come forward, right after the step being told', () => {
    const next = tellNext(walk, 'b>d', 1, live)!;
    expect(order(next.flow)).toEqual(['a>b', 'b>d', 'b>c', 'd>e']);
    expect(next.step).toBe(2);
    expect(next.flow.id).toBe(walk.id);
  });

  it('makes a connector the first step when clicked in the opening', () => {
    const next = tellNext(walk, 'd>e', 0, live)!;
    expect(order(next.flow)).toEqual(['d>e', 'a>b', 'b>c', 'b>d']);
    expect(next.step).toBe(1);
  });

  it('goes back to a connector already told without moving anything', () => {
    const next = tellNext(walk, 'a>b', 3, live)!;
    expect(order(next.flow)).toEqual(order(walk));
    expect(next.step).toBe(1);
    expect(next.flow).not.toBe(walk);
  });

  it('adds a connector the walk never had, and moves a shared step whole', () => {
    const part = walkOfSelection(doc, { nodes: ['a', 'c'], edges: [] })!.flow;
    expect(order(tellNext(part, 'b>d', 2, live)!.flow)).toEqual(['a>b', 'b>c', 'b>d']);

    const fan = graph({ gw: [0, 0], x: [200, -100], y: [200, 100], z: [-200, 0] }, ['z>gw', 'gw>x', 'gw>y']);
    const fanned = walkOfDiagram(fan)!.flow;
    const first = tellNext(fanned, 'gw>y', 0, new Set(fan.edges.map((edge) => edge.id)))!.flow;
    expect(first.steps[0]).toMatchObject({ edgeId: 'gw>x', extraEdgeIds: ['gw>y'] });
  });

  it('drops steps whose connectors are gone, and refuses a connector that is', () => {
    const fewer = new Set(['a>b', 'b>d', 'd>e']);
    expect(tellNext(walk, 'b>c', 1, fewer)).toBeNull();
    const next = tellNext(walk, 'd>e', 1, fewer)!;
    expect(order(next.flow)).toEqual(['a>b', 'd>e', 'b>d']);
  });
});
