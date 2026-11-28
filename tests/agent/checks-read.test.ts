import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agent/errors';
import { readDiagram } from '../../src/agent/read';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftDocument, DraftNode } from '../../src/document/types';

/*
 * An agent gets the same checks and the same impact reading the headless CLI prints, as facts, and
 * only when it asks: neither is in a plain read.
 */
const at = { x: 0, y: 0 };
const service = (id: string, text: string) => createNode({ id, type: 'service', text, ...at });
const calls = (id: string, source: string, target: string) => createEdge({ id, source, target, semantic: 'calls', semanticsOrigin: 'explicit' });
const junction = (id: string, link: string): DraftNode => ({ ...createNode({ id, type: 'ellipse', ...at }), link });

const inner = [junction('arrive', 'L'), createNode({ id: 'repo', type: 'component', text: 'Repository', ...at })];
const api: DraftNode = { ...service('api', 'API'), inside: { nodes: inner, edges: [calls('in', 'arrive', 'repo')], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
const file: DraftDocument = {
  ...createDocument('Shop'),
  nodes: [service('a', 'A'), service('b', 'B'), service('c', 'C'), api, junction('leave', 'L')],
  edges: [calls('ab', 'a', 'b'), calls('bc', 'b', 'c'), calls('ca', 'c', 'a'), calls('out', 'a', 'leave')],
};

describe('read_diagram checks and impact', () => {
  it('are absent unless asked for', () => {
    const read = readDiagram(file, {}, 'r', 'd');
    expect(read.checks).toBeUndefined();
    expect(read.impact).toBeUndefined();
  });

  it('lists what the checks find in every view, with stable ids', () => {
    const { checks } = readDiagram(file, { include: ['checks'] }, 'r', 'd') as { checks: { basis: string; counts: Record<string, number>; findings: { id: string; rule: string; ids: string[]; severity: string }[] } };
    expect(checks.basis).toMatch(/drawing alone/);
    // The loop through three parts, and "API" drawn with no connections of its own.
    expect(checks.counts).toEqual({ error: 0, warning: 1, info: 1 });
    expect(checks.findings.map((entry) => [entry.rule, entry.severity, entry.ids])).toEqual([
      ['model/dependency-cycle', 'warning', ['a', 'b', 'c']],
      ['review/unconnected', 'info', ['api']],
    ]);
    const again = readDiagram(file, { include: ['checks'] }, 'r', 'd') as { checks: typeof checks };
    expect(again.checks.findings.map((entry) => entry.id)).toEqual(checks.findings.map((entry) => entry.id));
  });

  it('says what a change to one element touches, through a linked junction into another view', () => {
    const { impact } = readDiagram(file, { impact: { element: 'a' } }, 'r', 'd') as { impact: { basis: string; reaches: { ids: string[]; total: number }; reachedBy: { ids: string[] } } };
    expect(impact.basis).toMatch(/not what was measured/);
    expect(impact.reaches).toEqual({ ids: ['b', 'repo', 'c'], total: 3 });
    expect(impact.reachedBy.ids).toEqual(['c', 'b']);
  });

  it('reads an element of an inside view, and refuses an id the diagram does not have', () => {
    expect(readDiagram(file, { impact: { element: 'repo' } }, 'r', 'd').impact).toMatchObject({ element: 'repo', view: ['api'], reachedBy: { ids: ['a', 'c', 'b'] } });
    expect(() => readDiagram(file, { impact: { element: 'nope' } }, 'r', 'd')).toThrow(AgentError);
    expect(() => readDiagram(file, { impact: 'a' as never }, 'r', 'd')).toThrow(/impact is \{element/);
  });
});
