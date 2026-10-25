import { describe, expect, it } from 'vitest';
import { createEdge, createNode, displayNameFor } from '../../src/document/factory';
import { EDGE_SEMANTICS, type DraftEdge, type DraftNode } from '../../src/document/types';
import { analyzeTraffic, mayHaveTraffic, trafficGroupOf, trafficRoleOf } from '../../src/traffic';

let nextId = 0;
function node(type: DraftNode['type'], options: Record<string, unknown> = {}): DraftNode {
  return createNode({ type, x: nextId++ * 10, y: 0, id: `n-${nextId}`, ...options } as never);
}

function edge(source: string, target: string, options: Record<string, unknown> = {}): DraftEdge {
  return createEdge({ source, target, id: `e-${nextId++}`, ...options } as never);
}

describe('traffic eligibility', () => {
  it('maps runtime kinds and excludes annotation kinds', () => {
    expect(trafficRoleOf(node('service', { serviceKind: 'gateway' }))).toBe('compute');
    expect(trafficGroupOf(node('service', { serviceKind: 'scheduler' }))).toBe('services');
    expect(trafficRoleOf(node('database', { databaseKind: 'table' }))).toBe('excluded');
    expect(trafficRoleOf(node('queue', { queueKind: 'stream' }))).toBe('messaging');
    expect(trafficRoleOf(node('actor', { actorKind: 'device' }))).toBe('origin');
    expect(trafficRoleOf(node('ellipse'))).toBe('junction');
    for (const type of ['component', 'text', 'note', 'code', 'group'] as const) expect(trafficRoleOf(node(type))).toBe('excluded');
  });
});

describe('traffic analysis', () => {
  it('counts a linear request chain and exposes the entry', () => {
    const a = node('service', { text: 'A' });
    const b = node('service', { text: 'B' });
    const c = node('database', { databaseKind: 'sql', text: 'DB' });
    const result = analyzeTraffic({ nodes: [a, b, c], edges: [edge(a.id, b.id, { semantic: 'calls' }), edge(b.id, c.id, { semantic: 'reads' })] });
    expect(result.status).toBe('ok');
    expect(result.entries).toEqual([a.id]);
    expect(result.nodes.get(c.id)?.paths).toEqual({ definite: 1, possible: 1 });
    expect(result.nodes.get(a.id)?.targets).toEqual([b.id]);
    expect(result.nodes.get(c.id)?.workloads).toEqual(['data']);
  });

  it('keeps queue consumers possible and topic subscribers definite', () => {
    const producer = node('service', { text: 'Producer' });
    const queue = node('queue', { queueKind: 'queue', text: 'Jobs' });
    const w1 = node('service', { serviceKind: 'worker', text: 'Worker A' });
    const w2 = node('service', { serviceKind: 'worker', text: 'Worker B' });
    const edges = [
      edge(producer.id, queue.id, { semantic: 'publishes' }),
      edge(queue.id, w1.id, { semantic: 'consumes' }),
      edge(queue.id, w2.id, { semantic: 'consumes' }),
    ];
    const result = analyzeTraffic({ nodes: [producer, queue, w1, w2], edges });
    expect(result.nodes.get(w1.id)?.paths).toEqual({ definite: 0, possible: 1 });
    expect(result.insights.some((insight) => insight.kind === 'competing-consumers')).toBe(true);

    const topic = node('queue', { queueKind: 'topic', text: 'Events' });
    const topicResult = analyzeTraffic({ nodes: [producer, topic, w1, w2], edges: [edge(producer.id, topic.id, { semantic: 'publishes' }), edge(topic.id, w1.id, { semantic: 'consumes' }), edge(topic.id, w2.id, { semantic: 'consumes' })] });
    expect(topicResult.nodes.get(w1.id)?.paths).toEqual({ definite: 1, possible: 1 });
  });

  it('flattens a junction without doubling paths and marks a split possible', () => {
    const a = node('service', { text: 'A' });
    const j = node('ellipse');
    const b = node('service', { text: 'B' });
    const c = node('service', { text: 'C' });
    const edges = [edge(a.id, j.id, { semantic: 'calls' }), edge(j.id, b.id, { semantic: 'calls' }), edge(j.id, c.id, { semantic: 'calls' })];
    const result = analyzeTraffic({ nodes: [a, j, b, c], edges });
    const routes = result.interactions.filter((interaction) => interaction.from === a.id);
    expect(routes).toHaveLength(2);
    expect(routes.every((interaction) => interaction.certainty === 'possible' && interaction.paths.definite === 0 && interaction.paths.possible === 1)).toBe(true);
    expect(result.insights.some((insight) => insight.kind === 'ambiguous-split')).toBe(true);
    expect(result.nodes.get(j.id)?.tier).toBe('none');
  });

  it('collapses a loop and reports no-entry for a pure cycle', () => {
    const a = node('service', { text: 'A' });
    const b = node('service', { text: 'B' });
    const result = analyzeTraffic({ nodes: [a, b], edges: [edge(a.id, b.id, { semantic: 'calls' }), edge(b.id, a.id, { semantic: 'calls' })] });
    expect(result.status).toBe('no-entry');
    expect(result.nodes.get(a.id)?.inLoop).toBe(true);
    expect(result.interactions.filter((interaction) => interaction.loop)).toHaveLength(2);
    expect(result.insights.some((insight) => insight.kind === 'loop')).toBe(true);
  });

  it('is bounded and handles duplicate ids and missing endpoints', () => {
    const a = node('service', { text: 'A' });
    const j = node('ellipse');
    const b = node('service', { text: 'B' });
    const first = edge(a.id, j.id, { id: 'same', semantic: 'calls' });
    const duplicate = edge(a.id, b.id, { id: 'same', semantic: 'calls' });
    const result = analyzeTraffic({ nodes: [a, j, b, b], edges: [first, duplicate, edge('missing', b.id, { semantic: 'calls' })] }, { maxJunctionSteps: 0, maxInteractions: 10 });
    expect(result.truncated).toBe(true);
    expect(result.interactions.some((interaction) => interaction.from === a.id && interaction.to === b.id)).toBe(false);
  });
});

describe('traffic hints and semantic coverage', () => {
  it('recognizes only baseline runtime hints', () => {
    const service = node('service');
    const db = node('database');
    const note = node('note');
    const component = node('component');
    expect(mayHaveTraffic(new Map([[service.id, service], [db.id, db]]), [edge(service.id, db.id, { semantic: 'reads' })])).toBe(true);
    expect(mayHaveTraffic(new Map([[note.id, note]]), [edge(note.id, note.id, { semantic: 'calls' })])).toBe(false);
    expect(mayHaveTraffic(new Map([[component.id, component]]), [edge(component.id, component.id, { semantic: 'dependsOn' })])).toBe(false);
    expect(EDGE_SEMANTICS).toHaveLength(EDGE_SEMANTICS.length);
    expect(displayNameFor(service)).toBe('Service');
  });
});
