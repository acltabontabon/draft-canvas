import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { routeGeometry } from '../../src/agent/route';
import { createDocument } from '../../src/document/factory';
import { deserializeDocument, serializeDocument } from '../../src/export/project';
import { nearbyServicesRequest as nearbyRequest } from '../fixtures/connectors/nearby';

// The same slightly offset service row that exposed the canvas attachment loop, authored through
// the public agent vocabulary instead of loading a document with automatic ends already in it.
const build = (request: Record<string, unknown> = nearbyRequest()) => {
  const parsed = deserializeDocument(compose(request, 'd_nearbyservices').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
};

describe('closest attachments through agent authoring', () => {
  it.each(['create', 'add'] as const)('keeps %s output automatic through serialization and reports the actual clear route', kind => {
    const request = nearbyRequest();
    const authored = kind === 'create' ? build(request) : applyUpdate(createDocument(), [], [{ op: 'add', nodes: request.nodes, relationships: request.relationships }], undefined).file;
    const parsed = deserializeDocument(serializeDocument(authored));
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parsed.document;
    expect([doc.edges[0]!.sourceAnchor, doc.edges[0]!.targetAnchor]).toEqual([undefined, undefined]);
    const nearby = routeGeometry(doc.edges[0]!, doc.nodes, doc.edges)!;
    expect(nearby).toMatchObject({ from: 'right', to: 'left', pins: {} });
    expect(nearby.path).toEqual([[350, nearby.path[0]![1]], [410, nearby.path[0]![1]]]);
    const through = routeGeometry(doc.edges[1]!, doc.nodes, doc.edges)!;
    expect(through.status).toBeUndefined();
    if (kind === 'create') {
      expect(through.pins).toEqual({});
      expect(through.path.at(-1)).toEqual([776, 25]);
    }
    const read = readDiagram(doc, { include: ['geometry'] }, 'r:1', 'd_nearbyservices');
    // A read leaves out pins when there are none: both ends automatic.
    const { pins: _none, ...drawn } = nearby;
    expect(read.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'nearby', geometry: drawn })]));
  });

  it('uses the same attachments inside an agent-created service view', () => {
    const request = nearbyRequest();
    const doc = build({ title: 'Nested', nodes: [{ id: 'owner', type: 'service', label: 'Owner', inside: { nodes: request.nodes, relationships: request.relationships } }], relationships: [] });
    const inside = doc.nodes[0]!.inside!;
    const geometry = routeGeometry(inside.edges[0]!, inside.nodes, inside.edges)!;
    expect(geometry).toEqual({ from: 'right', to: 'left', path: [[350, 75], [410, 75]], pins: {} });
  });

  it('keeps following the nearest sides after an agent moves a shape', () => {
    const { file } = applyUpdate(build(), [], [{ op: 'update', id: 'near', set: { place: { x: -410, y: 41 } } }], undefined);
    const geometry = routeGeometry(file.edges[0]!, file.nodes, file.edges)!;
    expect(geometry).toMatchObject({ from: 'left', to: 'right', pins: {} });
    expect(geometry.path[0]![1]).toBe(geometry.path.at(-1)![1]);
  });

  it('keeps explicitly requested pins and bends', () => {
    const request = nearbyRequest();
    const doc = build({ ...request, relationships: request.relationships.map(e => ({ ...e, route: { from: 'bottom', to: 'top', via: [[175, 230], [585, -60]] } })) });
    expect(doc.edges[0]).toMatchObject({ sourceAnchor: { side: 'bottom', offset: 0.5 }, targetAnchor: { side: 'top', offset: 0.5 }, waypoints: [{ x: 175, y: 230 }, { x: 585, y: -60 }] });
  });

  it('keeps layout pins when freeing them would crowd a caption', () => {
    const request = nearbyRequest();
    const doc = build({ ...request, relationships: request.relationships.map(e => ({ ...e, ...(e.id === 'nearby' ? { label: 'Connect' } : {}) })) });
    expect(doc.edges[0]!.sourceAnchor).toBeDefined();
    expect(doc.edges[0]!.label).toBe('Connect');
  });
});
