import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { ARCHITECTURE_NODE_FIELDS, classOfField, sameArchitecture } from '../../src/document/fieldClasses';
import type { DraftDocument, DraftEdge, DraftNode } from '../../src/document/types';
import { crossingsOf, cyclesOf, downstreamOf, membersOf, modelOf, sharedBy, upstreamOf } from '../../src/model';

type NodeInput = Parameters<typeof createNode>[0];
type EdgeInput = Parameters<typeof createEdge>[0];

const at = { x: 0, y: 0 };
const service = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'service', text, ...at, ...extra });
const database = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'database', databaseKind: 'sql', text, ...at, ...extra });
const junction = (id: string, extra: Partial<DraftNode> = {}) => ({ ...createNode({ id, type: 'ellipse', ...at }), ...extra });
const boundary = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'group', text, ...at, ...extra });
const edge = (id: string, source: string, target: string, extra: Partial<EdgeInput> = {}) => createEdge({ id, source, target, semantic: 'calls', semanticsOrigin: 'explicit', ...extra });

function file(nodes: DraftNode[], edges: DraftEdge[] = []): DraftDocument {
  return { ...createDocument('Shop'), nodes, edges };
}

describe('the architecture model', () => {
  it('reads parts, what they are and the boundaries around them', () => {
    const model = modelOf(
      file([
        boundary('sys', 'Shop', { boundaryPreset: 'system' }),
        boundary('net', 'Private network', { boundaryPreset: 'network', parentId: 'sys' }),
        service('api', 'Orders API\nv2', { serviceKind: 'api', parentId: 'net', technology: 'Spring Boot 3' }),
        database('db', 'Orders', { parentId: 'net', technology: 'PostgreSQL 16' }),
        createNode({ id: 'note', type: 'note', text: 'remember', ...at }),
      ]),
    );
    expect([...model.entities.keys()]).toEqual(['api', 'db']);
    const api = model.entities.get('api')!;
    expect(api).toMatchObject({ name: 'Orders API', category: 'service', technology: 'Spring Boot 3', product: 'spring boot', boundaries: ['net', 'sys'], hasInside: false });
    expect(api.c4).toMatchObject({ scope: 'internal' });
    expect(model.entities.get('db')!.product).toBe('postgresql');
    expect(model.boundaries.get('net')).toMatchObject({ preset: 'network', parent: 'sys', name: 'Private network' });
    expect(model.boundaries.get('sys')!.parent).toBeUndefined();
  });

  it('sees through Junctions, and says when one divides a relation', () => {
    const model = modelOf(
      file(
        [service('a', 'A'), junction('j1'), junction('j2'), service('b', 'B'), service('c', 'C')],
        [edge('e1', 'a', 'j1', { semantic: 'publishes' }), edge('e2', 'j1', 'j2'), edge('e3', 'j2', 'b'), edge('e4', 'j2', 'c', { kind: 'async' })],
      ),
    );
    expect(model.relations.map((relation) => [relation.id, relation.from, relation.to, relation.semantic, relation.split])).toEqual([
      ['e1>b', 'a', 'b', 'publishes', true],
      ['e1>c', 'a', 'c', 'publishes', true],
    ]);
    expect(model.relations[0]!.edges).toEqual(['e1', 'e2', 'e3']);
    expect(model.relations[0]!.via).toEqual(['j1', 'j2']);
    expect(model.relations[1]!.kind).toBe('async');
    expect(model.unread).toEqual([]);
  });

  it('lists what it could not read, with the reason, and never guesses', () => {
    const model = modelOf(
      file(
        [service('a', 'A'), junction('dead'), junction('orphan'), service('b', 'B'), junction('portal', { link: 'L1' }), createNode({ id: 'note', type: 'note', text: 'n', ...at })],
        [edge('to-dead', 'a', 'dead'), edge('from-orphan', 'orphan', 'b'), edge('to-portal', 'a', 'portal'), edge('to-note', 'a', 'note'), edge('self', 'a', 'a')],
      ),
    );
    expect(model.relations).toEqual([]);
    expect(Object.fromEntries(model.unread.map((entry) => [entry.edge, entry.reason]))).toEqual({
      'to-dead': 'dangling-junction',
      'from-orphan': 'dangling-junction',
      // A linked Junction is a way to travel to its counterpart, never a relationship.
      'to-portal': 'continued',
      'to-note': 'annotation',
      self: 'self',
    });
  });

  it('follows a linked Junction to its counterpart: two halves, one relation', () => {
    const model = modelOf(
      file(
        [service('bff', 'Mobile BFF'), junction('out', { link: 'A' }), junction('in', { link: 'A' }), service('profiles', 'Profiles API'), boundary('core', 'Core'), service('inside', 'Inside', { parentId: 'core' })],
        [edge('half1', 'bff', 'out', { semantic: 'http' }), edge('half2', 'in', 'profiles'), edge('half3', 'in', 'inside')],
      ),
    );
    expect(model.relations.map((relation) => [relation.id, relation.from, relation.to, relation.semantic, relation.linked, relation.split])).toEqual([
      ['half1>profiles', 'bff', 'profiles', 'http', true, true],
      ['half1>inside', 'bff', 'inside', 'http', true, true],
    ]);
    expect(model.relations[0]).toMatchObject({ edges: ['half1', 'half2'], via: ['out', 'in'] });
    expect(model.relations[1]!.crosses).toEqual(['core']);
    expect(model.unread).toEqual([]);
  });

  it('follows a link into another view, and keeps what is drawn here too', () => {
    const inner = [junction('arrive', { link: 'L' }), createNode({ id: 'repo', type: 'component', text: 'Repository', ...at }), boundary('data', 'Data'), createNode({ id: 'cache', type: 'component', text: 'Cache', parentId: 'data', ...at })];
    const owner: DraftNode = { ...service('api', 'API'), inside: { nodes: inner, edges: [edge('in1', 'arrive', 'repo', { semantic: 'uses' }), edge('in2', 'arrive', 'cache')], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const model = modelOf(file([service('web', 'Web'), junction('leave', { link: 'L' }), service('audit', 'Audit'), owner], [edge('out', 'web', 'leave'), edge('local', 'leave', 'audit')]));
    expect(model.relations.map((relation) => [relation.id, relation.to, relation.linked ?? false, relation.toRoom])).toEqual([
      ['out>audit', 'audit', false, undefined],
      ['out>repo', 'repo', true, ['api']],
      ['out>cache', 'cache', true, ['api']],
    ]);
    // Every boundary around the far end is crossed: the near end is not in that view at all.
    expect(model.relations[2]!.crosses).toEqual(['data']);
    expect(model.rooms[0]!.relations).toEqual(['out>audit', 'out>repo', 'out>cache']);
    expect(model.unread).toEqual([]);
  });

  it('leaves half a relation unread while its counterpart leads nowhere, and survives links in a ring', () => {
    const waiting = modelOf(file([service('a', 'A'), junction('j1', { link: 'X' }), junction('j2', { link: 'X' })], [edge('e', 'a', 'j1')]));
    expect(waiting.relations).toEqual([]);
    expect(waiting.unread).toEqual([{ edge: 'e', room: [], reason: 'continued' }]);
    const ring = modelOf(file([service('a', 'A'), junction('j1', { link: 'X' }), junction('j2', { link: 'X' }), junction('j3', { link: 'Y' }), junction('j4', { link: 'Y' })], [edge('e', 'a', 'j1'), edge('f', 'j2', 'j3'), edge('g', 'j4', 'j1')]));
    expect(ring.relations).toEqual([]);
  });

  it('survives a ring of Junctions', () => {
    const model = modelOf(file([service('a', 'A'), junction('j1'), junction('j2')], [edge('e1', 'a', 'j1'), edge('e2', 'j1', 'j2'), edge('e3', 'j2', 'j1')]));
    expect(model.relations).toEqual([]);
    expect(model.unread.map((entry) => entry.edge)).toEqual(['e1']);
  });

  it('names the boundaries a relation crosses', () => {
    const model = modelOf(
      file(
        [boundary('pay', 'Payments', { boundaryPreset: 'domain' }), boundary('ord', 'Orders', { boundaryPreset: 'domain' }), service('a', 'A', { parentId: 'ord' }), service('b', 'B', { parentId: 'pay' }), service('c', 'C', { parentId: 'pay' })],
        [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')],
      ),
    );
    expect(model.relations.find((relation) => relation.id === 'ab')!.crosses).toEqual(['ord', 'pay']);
    expect(model.relations.find((relation) => relation.id === 'bc')!.crosses).toEqual([]);
    expect(crossingsOf(model, 'pay').map((relation) => relation.id)).toEqual(['ab']);
    expect(membersOf(model, 'pay')).toEqual(['b', 'c']);
  });

  it('reads every room, and knows which shape owns each part', () => {
    const inner = [createNode({ id: 'ctl', type: 'component', text: 'Controller', ...at }), createNode({ id: 'repo', type: 'component', text: 'Repository', ...at })];
    const owner: DraftNode = { ...service('api', 'Orders API'), inside: { nodes: inner, edges: [edge('uses', 'ctl', 'repo', { semantic: 'uses' })], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const model = modelOf({ ...file([owner, database('db', 'Orders')], [edge('rw', 'api', 'db', { semantic: 'readsWrites' })]), level: 'container' });
    expect(model.rooms.map((room) => [room.path, room.level, room.entities])).toEqual([
      [[], 'container', ['api', 'db']],
      [['api'], 'component', ['ctl', 'repo']],
    ]);
    expect(model.entities.get('api')!.hasInside).toBe(true);
    expect(model.entities.get('ctl')).toMatchObject({ owner: 'api', room: ['api'] });
    expect(model.entities.get('ctl')!.c4).toMatchObject({ role: 'component', scope: 'internal' });
    expect(model.relations.map((relation) => [relation.id, relation.room])).toEqual([
      ['rw', []],
      ['uses', ['api']],
    ]);
  });

  it('answers from memory for the same file, and re-reads only the room that changed', () => {
    const nodes = [service('a', 'A'), service('b', 'B')];
    const edges = [edge('ab', 'a', 'b')];
    const first = file(nodes, edges);
    const model = modelOf(first);
    expect(modelOf(first)).toBe(model);
    // A new file object over the same arrays (a title change, say) reuses every part it read.
    const renamed = { ...first, metadata: { ...first.metadata, title: 'Other' } };
    expect(modelOf(renamed).entities.get('a')).toBe(model.entities.get('a'));
    const moved = { ...first, nodes: [{ ...nodes[0]!, text: 'Renamed' }, nodes[1]!] };
    expect(modelOf(moved).entities.get('a')!.name).toBe('Renamed');
  });
});

describe('graph questions', () => {
  const model = modelOf(
    file(
      [service('web', 'Web'), service('api', 'API'), service('pay', 'Pay'), database('db', 'DB'), service('audit', 'Audit')],
      [edge('1', 'web', 'api'), edge('2', 'api', 'pay'), edge('3', 'pay', 'api'), edge('4', 'api', 'db', { semantic: 'writes' }), edge('5', 'audit', 'db', { semantic: 'writes' })],
    ),
  );

  it('walks the arrows both ways, nearest first', () => {
    expect(downstreamOf(model, 'web')).toMatchObject({ ids: ['api', 'pay', 'db'], distance: { api: 1, pay: 2, db: 2 }, truncated: false });
    expect(upstreamOf(model, 'db').ids).toEqual(['api', 'audit', 'web', 'pay']);
    expect(downstreamOf(model, 'db').ids).toEqual([]);
  });

  it('stops at its limit and says so', () => {
    expect(downstreamOf(model, 'web', undefined, 1)).toMatchObject({ ids: ['api'], truncated: true });
  });

  it('finds loops, and what several parts share', () => {
    expect(cyclesOf(model)).toEqual([['api', 'pay']]);
    expect(cyclesOf(model, (relation) => relation.semantic === 'writes')).toEqual([]);
    expect(sharedBy(model, (relation) => relation.semantic === 'writes')).toEqual([{ id: 'db', by: ['api', 'audit'] }]);
  });

  it('never makes a loop out of a line with no arrow', () => {
    const plain = modelOf(file([service('a', 'A'), service('b', 'B')], [edge('ab', 'a', 'b', { directed: false })]));
    expect(cyclesOf(plain)).toEqual([]);
    expect(upstreamOf(plain, 'a').ids).toEqual(['b']);
  });
});

describe('what a field means', () => {
  it('files a boundary\'s kind as meaning, not style', () => {
    expect(classOfField('boundaryPreset')).toBe('property');
    expect(classOfField('accent')).toBe('style');
    expect(classOfField('x')).toBe('layout');
    expect(classOfField('semantic')).toBe('relationship');
    expect(classOfField('parentId')).toBe('grouping');
    expect(classOfField('somethingNew')).toBe('property');
    expect(classOfField('toString')).toBe('property');
  });

  it('tells a move or a restyle from a change of meaning', () => {
    const a = service('a', 'A');
    expect(sameArchitecture(a, { ...a, x: 400, accent: 'blue' })).toBe(true);
    for (const field of ARCHITECTURE_NODE_FIELDS) {
      expect(sameArchitecture(a, { ...a, [field]: 'changed' } as DraftNode), field).toBe(false);
    }
  });
});
