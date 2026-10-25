import { describe, expect, it } from 'vitest';
import { createDocument } from '../../src/document/factory';
import { roomMayHaveTraffic } from '../../src/store/traffic';
import { analyzeTraffic, mayHaveTraffic, MAX_HOTSPOTS } from '../../src/traffic';
import { edge, interaction, node } from './helpers';

describe('traffic review regressions', () => {
  it('follows Junction chains in the traffic entry hint and agrees with analysis', () => {
    const service = node('service', 'service');
    const j1 = node('j1', 'ellipse');
    const j2 = node('j2', 'ellipse');
    const database = node('database', 'database', { databaseKind: 'sql' });
    const nodes = new Map([service, j1, j2, database].map((value) => [value.id, value]));
    const throughJunctions = [
      edge('service-j1', service.id, j1.id),
      edge('j1-j2', j1.id, j2.id),
      edge('j2-database', j2.id, database.id, { semantic: 'readsWrites' }),
    ];

    expect(mayHaveTraffic(nodes, throughJunctions)).toBe(true);

    const failedService = node('failed-service', 'service');
    const failedJunction = node('failed-junction', 'ellipse');
    const failedNodes = new Map([failedService, failedJunction, service].map((value) => [value.id, value]));
    const failureRoute = [
      edge('failed-service-junction', failedService.id, failedJunction.id, { semantic: 'calls' }),
      edge('junction-service-failure', failedJunction.id, service.id, { semantic: 'calls', kind: 'failure' }),
    ];
    const analysis = analyzeTraffic({ nodes: [...failedNodes.values()], edges: failureRoute });

    expect(mayHaveTraffic(failedNodes, failureRoute)).toBe(false);
    expect(analysis.status).toBe('nothing-to-analyze');
  });

  it('merges duplicate request connectors conservatively for sync chains', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const c = node('c', 'service');
    const d = node('d', 'service');
    const result = analyzeTraffic({
      nodes: [a, b, c, d],
      edges: [
        edge('a-b-sync', a.id, b.id, { semantic: 'calls' }),
        edge('a-b-async', a.id, b.id, { semantic: 'calls', async: true }),
        edge('b-c', b.id, c.id, { semantic: 'calls' }),
        edge('c-d', c.id, d.id, { semantic: 'calls' }),
      ],
    });

    expect(interaction(result, a.id, b.id, 'request').sync).toBe(false);
    expect(result.insights.some((value) => value.kind === 'sync-chain')).toBe(false);
  });

  it('caps both the hotspot list and the nodes that receive tiers', () => {
    const sources = Array.from({ length: 24 }, (_, index) => node(`source-${index}`, 'service'));
    const targets = Array.from({ length: 12 }, (_, index) => node(`target-${index}`, 'service'));
    const edges = targets.flatMap((target, index) => [
      edge(`${target.id}-source-a`, sources[index * 2]!.id, target.id, { semantic: 'calls' }),
      edge(`${target.id}-source-b`, sources[index * 2 + 1]!.id, target.id, { semantic: 'calls' }),
    ]);
    const result = analyzeTraffic({ nodes: [...sources, ...targets], edges });

    expect(result.hotspots).toHaveLength(MAX_HOTSPOTS);
    expect([...result.nodes.values()].filter((value) => value.tier !== 'none')).toHaveLength(MAX_HOTSPOTS);
  });

  it('bounds an unfed thousand-Junction chain without throwing', () => {
    const junctions = Array.from({ length: 1_000 }, (_, index) => node(`junction-${index}`, 'ellipse'));
    const service = node('service', 'service');
    const edges = [
      ...junctions.slice(0, -1).map((value, index) => edge(`junction-${index}`, value.id, junctions[index + 1]!.id, { semantic: 'calls' })),
      edge('last-junction-service', junctions[junctions.length - 1]!.id, service.id, { semantic: 'calls' }),
    ];
    const started = performance.now();
    const result = analyzeTraffic({ nodes: [...junctions, service], edges }, { maxJunctionSteps: 10, maxInteractions: 1_000 });
    const elapsed = performance.now() - started;

    expect(result.truncated).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  it('stops at the first excluded shape and names it', () => {
    const service = node('service', 'service', { text: 'Service' });
    const component = node('component', 'component', { componentKind: 'module', text: 'First Component' });
    const adapter = node('adapter', 'component', { componentKind: 'adapter', text: 'Adapter' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'Database' });
    const result = analyzeTraffic({
      nodes: [service, component, adapter, database],
      edges: [
        edge('service-component', service.id, component.id, { semantic: 'calls' }),
        edge('component-adapter', component.id, adapter.id, { semantic: 'calls' }),
        edge('adapter-database', adapter.id, database.id, { semantic: 'readsWrites' }),
      ],
    });

    expect(result.interactions.some((value) => value.from === service.id && value.to === database.id)).toBe(false);
    expect(result.insights.filter((value) => value.kind === 'unsupported-hop')).toHaveLength(1);
    expect(result.insights.find((value) => value.kind === 'unsupported-hop')?.text).toMatch(/First Component/);
  });

  it('treats multiple gateway routes as a routed split but keeps one route definite', () => {
    const gateway = node('gateway', 'service', { serviceKind: 'gateway' });
    const a = node('a', 'service');
    const b = node('b', 'service');
    const split = analyzeTraffic({
      nodes: [gateway, a, b],
      edges: [edge('gateway-a', gateway.id, a.id, { semantic: 'routes' }), edge('gateway-b', gateway.id, b.id, { semantic: 'routes' })],
    });

    expect(split.interactions.filter((value) => value.from === gateway.id)).toMatchObject([
      { to: a.id, certainty: 'possible', uncertainty: 'routed' },
      { to: b.id, certainty: 'possible', uncertainty: 'routed' },
    ]);
    expect(split.insights.some((value) => value.kind === 'routed-split')).toBe(true);
    expect(split.hotspots).not.toEqual(expect.arrayContaining([a.id, b.id]));

    const single = analyzeTraffic({ nodes: [gateway, a], edges: [edge('gateway-a-single', gateway.id, a.id, { semantic: 'routes' })] });
    const singleRoute = interaction(single, gateway.id, a.id, 'request');
    expect(singleRoute.certainty).toBe('definite');
    expect(singleRoute.uncertainty).toBeUndefined();
  });

  it('tiers the upstream meeting point, not its one-source downstream continuation', () => {
    const sources = ['a', 'b', 'c'].map((id) => node(id, 'service'));
    const meeting = node('meeting', 'service');
    const downstream = node('downstream', 'service');
    const result = analyzeTraffic({
      nodes: [...sources, meeting, downstream],
      edges: [
        ...sources.map((value) => edge(`${value.id}-meeting`, value.id, meeting.id, { semantic: 'calls' })),
        edge('meeting-downstream', meeting.id, downstream.id, { semantic: 'calls' }),
      ],
    });

    expect(result.nodes.get(meeting.id)).toMatchObject({ sources: sources.map((value) => value.id).sort(), paths: { possible: 3 }, tier: expect.not.stringMatching(/^none$/) });
    expect(result.nodes.get(downstream.id)).toMatchObject({ sources: [meeting.id], paths: { possible: 3 }, tier: 'none' });
  });

  it('reuses room traffic eligibility for moved nodes with a shared edge array', () => {
    const first = node('first', 'service');
    const second = node('second', 'service');
    const nodes = [first, second];
    const edges = Array.from({ length: 2_000 }, (_, index) => edge(`structural-${index}`, first.id, second.id, { semantic: 'dependsOn' }));
    const document = createDocument('structural room');
    document.nodes = nodes;
    document.edges = edges;
    expect(roomMayHaveTraffic({ document })).toBe(false);

    const movedNodes = nodes.map((value) => ({ ...value, x: value.x + 10, y: value.y + 10 }));
    const movedDocument = { ...document, nodes: movedNodes };
    expect(roomMayHaveTraffic({ document: movedDocument })).toBe(false);
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) roomMayHaveTraffic({ document: movedDocument });
    expect(performance.now() - started).toBeLessThan(50);
  });
});
