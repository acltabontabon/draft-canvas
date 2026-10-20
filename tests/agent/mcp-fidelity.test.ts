import { describe, expect, it } from 'vitest';
import { createAttachment, createDocument, createEdge, createNode } from '../../src/document/factory';
import { compose } from '../../src/agent/compile';
import { deserializeDocument, serializeDocument } from '../../src/export/project';
import { readAttachment, readDiagram, READ_LIMITS } from '../../src/agent/read';
import { applyUpdate } from '../../src/agent/patch';
import { diffForReview, prepareProposal, preconditionConflicts } from '../../src/agent/proposal';
import { schemaProblems, validateToolInput } from '../../src/agent/contract';
import { TOOLS } from '../../src/agent/schema';
import { renderFocus } from '../../src/agent/focus';
import { routeGeometry } from '../../src/agent/route';
import { viewOf } from '../../src/depth/tree';
import type { DraftDocument } from '../../src/document/types';

const node = (id: string, x = 0) => createNode({ id, type: 'service', text: id, x, y: 0 });
const base = () => ({ ...createDocument(), nodes: [node('api'), node('db', 500)], edges: [createEdge({ id: 'r', source: 'api', target: 'db', semantic: 'calls', kind: 'sync' })] });
const build = (raw: Record<string, unknown>) => {
  const parsed = deserializeDocument(compose({ title: 'Fidelity', ...raw }, 'd_fidelity0001').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
};
type Read = { elements: { id: string; attachments?: { text: string; truncated?: boolean }[] }[]; relationships: { id: string }[]; flows: { id: string; variantOf?: string; color?: string }[]; cursor?: string; partial?: boolean; completeness: Record<string, boolean> };
const read = (file: DraftDocument, args = {}) => readDiagram(file, args, 'f:one', 'd_one') as unknown as Read;

describe('MCP fidelity regressions', () => {
  it('captures deletion targets and their connectors, preventing later edits being silently deleted', () => {
    const file = base();
    const proposal = prepareProposal(file, [], [{ op: 'remove', ids: ['api'] }], undefined, undefined);
    const changed = { ...file, nodes: file.nodes.map((n) => n.id === 'api' ? { ...n, text: 'Changed by person' } : n) };
    expect(preconditionConflicts(changed, [], proposal.preconditions).map((c) => c.id)).toContain('api');
    expect(proposal.preconditions.entities?.r).toBeDefined();
  });

  it('detects concurrent edits to technology, attachments, flows and connector direction', () => {
    const file = base();
    file.nodes[0]!.attachments = [createAttachment({ id: 'decision', type: 'note', text: 'Old decision' })];
    file.flows = [{ id: 'f', title: 'Original', steps: [{ id: 's', edgeId: 'r' }] }];
    for (const ops of [
      [{ op: 'update', id: 'api', set: { technology: 'Rust' } }],
      [{ op: 'update', id: 'decision', set: { text: 'Proposed decision' } }],
      [{ op: 'update', id: 'f', set: { title: 'Proposed flow' } }],
      [{ op: 'update', id: 'r', set: { directed: false } }],
    ]) {
      const proposed = prepareProposal(file, [], ops, undefined, undefined);
      const edited = applyUpdate(file, [], ops, undefined).file;
      expect(preconditionConflicts(edited, [], proposed.preconditions).length).toBeGreaterThan(0);
      expect(diffForReview(file, edited, []).length).toBeGreaterThan(0);
    }
  });

  it('captures added connector endpoints as dependencies without blocking unrelated changes', () => {
    const file = base();
    const proposal = prepareProposal(file, [], [{ op: 'add', nodes: [{ id: 'worker', type: 'worker', label: 'Worker' }], relationships: [{ id: 'new', from: 'api', to: 'worker' }] }], undefined, undefined);
    expect(proposal.preconditions.entities?.api).toBeDefined();
    const other = { ...file, nodes: file.nodes.map((n) => n.id === 'db' ? { ...n, text: 'Unrelated' } : n) };
    expect(preconditionConflicts(other, [], proposal.preconditions)).toEqual([]);
  });

  it('paginates relationships independently without claiming omitted edges are complete', () => {
    const file = createDocument();
    file.nodes = Array.from({ length: 35 }, (_, i) => node(`n${i}`, i * 500));
    for (let i = 0; i < 35; i += 1) for (let j = i + 1; j < 35; j += 1) file.edges.push(createEdge({ id: `e${i}_${j}`, source: `n${i}`, target: `n${j}` }));
    const first = read(file);
    expect(first.relationships).toHaveLength(400);
    expect(first.completeness.relationships).toBe(false);
    const second = read(file, { cursor: first.cursor });
    expect(second.relationships).toHaveLength(195);
    expect(new Set([...first.relationships, ...second.relationships].map((e) => e.id)).size).toBe(595);
    expect(second.cursor).toBeUndefined();
  });

  it('keeps a page cursor short however many ids the read was focused on, and still refuses it for another focus', () => {
    const file = createDocument();
    file.nodes = Array.from({ length: 220 }, (_, i) => node(`service-with-a-long-name-${i}`, i * 500));
    for (let i = 0; i < 219; i += 1) for (const j of [1, 2, 3]) if (i + j < 220) file.edges.push(createEdge({ id: `e${i}_${j}`, source: `service-with-a-long-name-${i}`, target: `service-with-a-long-name-${i + j}` }));
    const focus = { nodes: file.nodes.map((n) => n.id).slice(0, 200) };
    const first = read(file, { focus });
    expect(first.cursor).toBeDefined();
    expect(first.cursor!.length).toBeLessThan(400);
    expect(() => read(file, { focus: { nodes: focus.nodes.slice(1) }, cursor: first.cursor })).toThrow(/changed since/);
    expect(read(file, { focus, cursor: first.cursor }).relationships.length).toBeGreaterThanOrEqual(0);
  });

  it('paginates every flow and returns variant relationships and colours', () => {
    const file = base();
    file.flows = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, title: `F${i}`, accent: 'rose', ...(i === 20 ? { variantOf: 'f0' } : {}), steps: [{ id: `s${i}`, edgeId: 'r' }] }));
    const first = read(file);
    expect(first.completeness.flows).toBe(false);
    const second = read(file, { cursor: first.cursor });
    expect(second.flows).toEqual([expect.objectContaining({ id: 'f20', variantOf: 'f0', color: 'rose' })]);
    expect(read(file, { focus: { flow: 'f20' } }).flows[0]?.id).toBe('f20');
  });

  it('marks attachment truncation and permits retrieving the original text', () => {
    const file = base();
    file.nodes[0]!.attachments = [createAttachment({ id: 'a', type: 'note', text: 'x'.repeat(1000) })];
    expect(read(file, { include: ['attachments'] }).elements[0]?.attachments?.[0]?.truncated).toBe(true);
    const full = read(file, { focus: { nodes: ['api'] }, include: ['fullText'] });
    expect(full.elements[0]?.attachments?.[0]?.text).toHaveLength(1000);
    expect(full.elements[0]?.attachments?.[0]?.truncated).toBeUndefined();
  });

  it('retrieves a large Unicode attachment in revision-checked chunks without missing its tail', () => {
    const file = base();
    const text = '界🙂'.repeat(12_000);
    file.nodes[0]!.attachments = [createAttachment({ id: 'a', type: 'note', text })];
    let offset: number | null = 0;
    let complete = '';
    while (offset !== null) {
      const chunk = readAttachment(file, { attachmentId: 'a', expectedRevision: 'f:one', offset }, 'f:one', 'd_one');
      expect([...('text' in chunk ? chunk.text : chunk.code)].length).toBeLessThanOrEqual(8192);
      complete += 'text' in chunk ? chunk.text : chunk.code;
      offset = chunk.nextOffset;
    }
    expect(complete).toBe(text);
    expect(() => readAttachment(file, { attachmentId: 'a', expectedRevision: 'f:one', offset: 8192 }, 'f:two', 'd_one')).toThrow(/changed/);
  });

  it('enforces the actual UTF-8 ceiling even when flows and attachments dominate the response', () => {
    const file = base();
    file.nodes = Array.from({ length: 10 }, (_, i) => ({ ...node(`n${i}`), attachments: Array.from({ length: 12 }, (_, j) => createAttachment({ id: `a${i}_${j}`, type: 'note', text: '界'.repeat(600) })) }));
    file.edges = [];
    file.flows = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, title: `F${i}`, steps: Array.from({ length: 200 }, (_, j) => ({ id: `s${i}_${j}`, viewport: { x: 0, y: 0, zoom: 1 } })) }));
    let cursor: string | undefined;
    let pages = 0;
    const flows = new Set<string>();
    do {
      const page = read(file, { include: ['attachments'], ...(cursor ? { cursor } : {}) });
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(READ_LIMITS.bytes);
      page.flows.forEach((f) => flows.add(f.id));
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor);
    expect(flows.size).toBe(20);
  });

  it('keeps routed geometry accurate when fitting pages with large attachments and reading a changed snapshot', () => {
    const file = base();
    file.nodes = Array.from({ length: 20 }, (_, i) => ({ ...node(`n${i}`, i * 500), attachments: Array.from({ length: 8 }, (_, j) => createAttachment({ id: `a${i}_${j}`, type: 'note', text: '界'.repeat(600) })) }));
    file.edges = Array.from({ length: 10 }, (_, i) => createEdge({ id: `e${i}`, source: `n${i * 2}`, target: `n${i * 2 + 1}` }));
    const args = { include: ['geometry', 'attachments'] };
    const first = readDiagram(file, args, 'f:one', 'd_one');
    expect(first.cursor).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(READ_LIMITS.bytes);
    const relationships = first.relationships as { id: string; geometry: unknown }[];
    expect(relationships.length).toBeGreaterThan(0);
    for (const edge of relationships) expect(edge.geometry).toEqual(routeGeometry(file.edges.find((e) => e.id === edge.id)!, file.nodes, file.edges));
    const changed = { ...file, nodes: file.nodes.map((n, i) => i === 0 ? { ...n, x: n.x - 100 } : n) };
    const next = readDiagram(changed, args, 'f:two', 'd_one').relationships as { id: string; geometry: unknown }[];
    expect(next[0]!.geometry).not.toEqual(relationships[0]!.geometry);
    expect(next[0]!.geometry).toEqual(routeGeometry(changed.edges[0]!, changed.nodes, changed.edges));
  });

  it('packs large collections separately when their first items do not fit on the same page', () => {
    const file = base();
    file.nodes = Array.from({ length: 201 }, (_, i) => node(`n${i}`, i * 500));
    file.nodes[0]!.attachments = Array.from({ length: 12 }, (_, i) => createAttachment({ id: `a${i}`, type: 'note', text: '🙂'.repeat(400) }));
    file.nodes[0]!.evidence = Array.from({ length: 8 }, () => ({ path: `src/${'x'.repeat(490)}`, basis: 'inferred', symbol: 'x'.repeat(200), explanation: '🙂'.repeat(300) }));
    file.edges = Array.from({ length: 200 }, (_, i) => createEdge({ id: `e${i}`, source: 'n0', target: `n${i + 1}` }));
    file.flows = [{ id: 'f', title: 'Large flow', steps: file.edges.map((e, i) => ({ id: `s${i}`, edgeId: e.id, caption: '界'.repeat(120) })) }];
    const first = read(file, { include: ['attachments'] });
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(READ_LIMITS.bytes);
    expect(first.cursor).toBeDefined();
    let cursor = first.cursor;
    const elements = new Set(first.elements.map((n) => n.id));
    const flows = new Set(first.flows.map((f) => f.id));
    for (let page = 0; cursor && page < 100; page += 1) {
      const next = read(file, { include: ['attachments'], cursor });
      next.elements.forEach((n) => elements.add(n.id));
      next.flows.forEach((f) => flows.add(f.id));
      expect(next.cursor).not.toBe(cursor);
      cursor = next.cursor;
    }
    expect(cursor).toBeUndefined();
    expect(elements.size).toBe(201);
    expect(flows.size).toBe(1);
  });

  it('binds cursors to the diagram and focus as well as revision and view', () => {
    const file = base();
    file.flows = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, title: `F${i}`, steps: [] }));
    const cursor = read(file).cursor;
    expect(() => read(file, { cursor, focus: { nodes: ['api'] } })).toThrow(/changed/);
    expect(() => readDiagram(file, { cursor }, 'f:one', 'd_other')).toThrow(/changed/);
  });

  it('keeps a cursor usable when equivalent focus keys or IDs are reordered', () => {
    const file = base();
    file.flows = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, title: `F${i}`, steps: [] }));
    const first = read(file, { focus: { nodes: ['api', 'db'], group: undefined } });
    expect(() => read(file, { cursor: first.cursor, focus: { group: undefined, nodes: ['db', 'api'] } })).not.toThrow();
  });

  it('reviews attachments by identity and lists everything removed inside an owner', () => {
    const file = build({ nodes: [{ id: 'api', type: 'api', label: 'API', inside: { nodes: [{ id: 'handler', type: 'component', label: 'Handler' }], flows: [{ id: 'frameFlow', title: 'Inside', steps: [] }] } }], notes: [{ id: 'decision', text: 'Keep this', about: 'api' }] });
    const renamed = applyUpdate(file, [], [{ op: 'update', id: 'api', set: { label: 'Renamed API' } }], undefined).file;
    expect(diffForReview(file, renamed, []).filter((row) => row.kind === 'attachment')).toEqual([]);
    const removed = applyUpdate(file, [], [{ op: 'remove', ids: ['api'] }], undefined).file;
    expect(diffForReview(file, removed, []).map((row) => row.id)).toEqual(expect.arrayContaining(['api', 'handler', 'frameFlow', 'decision']));
  });

  it('rejects unknown patch fields and fields belonging to another op at runtime', () => {
    expect(() => applyUpdate(base(), [], [{ op: 'update', id: 'api', set: { technlogy: 'Rust' } }], undefined)).toThrow(/unsupported field/);
    expect(() => applyUpdate(base(), [], [{ op: 'update', id: 'api', set: { label: 'A' }, ids: ['db'] }], undefined)).toThrow(/unsupported field/);
    expect(() => applyUpdate(base(), [], [{ op: 'update', id: 'api', set: {} }], undefined)).toThrow(/at least one/);
  });

  it('clears connector semantics and kind instead of silently keeping them', () => {
    const next = applyUpdate(base(), [], [{ op: 'update', id: 'r', set: { semantic: null, kind: null } }], undefined);
    expect(next.file.edges[0]?.semantic).toBeUndefined();
    expect(next.file.edges[0]?.kind).toBeUndefined();
    expect(next.counts.updated).toBe(1);
  });

  it('retains source evidence through import, reads, edits and proposal diffs', () => {
    const evidence = [{ path: 'src/orders.ts', basis: 'observed', symbol: 'placeOrder', line: 42, commit: 'abc123' }];
    const file = build({ nodes: [{ id: 'api', type: 'api', label: 'Orders', evidence }, { id: 'db', type: 'database', label: 'DB' }], relationships: [{ id: 'r', from: 'api', to: 'db', evidence }] });
    expect(file.nodes[0]?.evidence).toEqual(evidence);
    expect(file.edges[0]?.evidence).toEqual(evidence);
    const parsed = deserializeDocument(serializeDocument(file));
    expect(parsed.ok && parsed.document.nodes[0]?.evidence).toEqual(evidence);
    const changed = applyUpdate(file, [], [{ op: 'update', id: 'api', set: { evidence: null } }], undefined).file;
    expect(diffForReview(file, changed, [])[0]?.fields?.some((f) => f.field === 'evidence')).toBe(true);
    expect(() => build({ nodes: [{ id: 'api', type: 'api', label: 'Orders', evidence: [{ path: '../private/key', basis: 'observed' }] }] })).toThrow();
  });

  it('keeps source evidence out of shape geometry and refuses URI references', () => {
    const file = base();
    file.nodes[0] = { ...file.nodes[0]!, width: 24, height: 24 };
    const evidence = [{ path: 'src/orders.ts', basis: 'observed' }];
    const result = applyUpdate(file, [], [{ op: 'update', id: 'api', set: { evidence } }], undefined);
    expect(result.file.nodes[0]).toMatchObject({ x: 0, y: 0, width: 24, height: 24 });
    expect(result.quality.errors).toEqual([]);
    expect(prepareProposal(file, [], [{ op: 'update', id: 'api', set: { evidence } }], undefined, undefined).preconditions.entities?.api).toBeDefined();
    expect(() => build({ nodes: [{ id: 'api', type: 'api', label: 'API', evidence: [{ path: 'https://example.com/source.ts', basis: 'observed' }] }] })).toThrow();
  });

  it('moves a complete subgraph inward while preserving IDs, attachments, evidence and flows', () => {
    const file = build({
      nodes: [{ id: 'system', type: 'service', label: 'Orders' }, { id: 'api', type: 'api', label: 'API' }, { id: 'db', type: 'database', label: 'DB' }],
      relationships: [{ id: 'r', from: 'api', to: 'db' }],
      flows: [{ id: 'f', title: 'Save order', steps: ['r'] }], notes: [{ id: 'decision', text: 'Writes atomically', about: 'api' }],
    });
    const next = applyUpdate(file, [], [{ op: 'moveInside', owner: 'system', ids: ['api', 'db'] }], undefined).file;
    expect(next.nodes.map((n) => n.id)).toEqual(['system']);
    const inside = viewOf(next, ['system'])!;
    expect(inside.nodes.map((n) => n.id)).toEqual(['api', 'db']);
    expect(inside.edges[0]?.id).toBe('r');
    expect(inside.flows[0]?.id).toBe('f');
    expect(inside.nodes[0]?.attachments?.[0]?.id).toBe('decision');
    const parsed = deserializeDocument(serializeDocument(next));
    expect(parsed.ok && parsed.repairs).toEqual([]);
  });

  it('moves shapes inward beside detail already there, not on top of it', () => {
    const file = build({
      nodes: [
        { id: 'core', type: 'service', label: 'Orders', inside: { nodes: [{ id: 'r', type: 'component', label: 'Routes' }, { id: 'v', type: 'component', label: 'Validation' }], relationships: [{ id: 'rv', from: 'r', to: 'v' }] } },
        { id: 'api', type: 'api', label: 'API' },
        { id: 'db', type: 'database', label: 'DB' },
      ],
      relationships: [{ id: 'w', from: 'api', to: 'db' }],
    });
    const next = applyUpdate(file, [], [{ op: 'moveInside', owner: 'core', ids: ['db'] }], undefined);
    expect(next.quality.errors).toEqual([]);
    const inside = viewOf(next.file, ['core'])!;
    const db = inside.nodes.find((n) => n.id === 'db')!;
    for (const other of inside.nodes.filter((n) => n.id !== 'db')) {
      const apart = db.x >= other.x + other.width || other.x >= db.x + db.width || db.y >= other.y + other.height || other.y >= db.y + db.height;
      expect(apart, `db overlaps ${other.id}`).toBe(true);
    }
  });

  it('re-infers a connector moveInside re-points at the owner, as moveOutside does', () => {
    const file = build({
      nodes: [{ id: 'core', type: 'service', label: 'Orders' }, { id: 'api', type: 'api', label: 'API' }, { id: 'db', type: 'database', label: 'DB' }],
      relationships: [{ id: 'r', from: 'api', to: 'db' }],
    });
    const fresh = build({ nodes: [{ id: 'core', type: 'service', label: 'Orders' }, { id: 'api', type: 'api', label: 'API' }], relationships: [{ id: 'r', from: 'api', to: 'core' }] });
    const next = applyUpdate(file, [], [{ op: 'moveInside', owner: 'core', ids: ['db'] }], undefined).file;
    const edge = next.edges.find((e) => e.id === 'r')!;
    expect(edge).toMatchObject({ source: 'api', target: 'core' });
    expect(edge.semantic).toBe(fresh.edges[0]!.semantic);
    expect(edge.semantic).not.toBe(file.edges[0]!.semantic);
  });

  it('sends back a step a person lit a note with, unchanged', () => {
    const file = base();
    file.nodes.push(createNode({ id: 'n1', type: 'note', text: 'Why it waits', x: 0, y: 200 }));
    file.flows = [{ id: 'f', title: 'Save', steps: [{ id: 's', edgeId: 'r', extraNodeIds: ['n1'] }] }];
    const next = applyUpdate(file, [], [{ op: 'update', id: 'f', set: { steps: [{ relationship: 'r', caption: 'Saved', highlight: ['n1'] }] } }], undefined).file;
    expect(next.flows[0]?.steps[0]).toMatchObject({ edgeId: 'r', caption: 'Saved', extraNodeIds: ['n1'] });
  });

  it('refuses one add into two existing boundaries instead of putting both in the first', () => {
    const file = build({
      groups: [{ id: 'g1', label: 'Orders', kind: 'boundary' }, { id: 'g2', label: 'Billing', kind: 'boundary' }],
      nodes: [{ id: 'a', type: 'service', label: 'A', group: 'g1' }, { id: 'b', type: 'service', label: 'B', group: 'g2' }],
      relationships: [{ id: 'ab', from: 'a', to: 'b' }],
    });
    const add = (nodes: unknown[]) => applyUpdate(file, [], [{ op: 'add', nodes }], undefined);
    expect(() => add([{ id: 'x', type: 'worker', label: 'X', group: 'g1' }, { id: 'y', type: 'worker', label: 'Y', group: 'g2' }])).toThrow(/one existing boundary/);
    expect(add([{ id: 'x', type: 'worker', label: 'X', group: 'g1' }]).file.nodes.find((n) => n.id === 'x')?.parentId).toBe('g1');
  });

  it('refuses a cursor that is not an object instead of crashing', () => {
    for (const cursor of ['null', '1', '"text"']) expect(() => read(base(), { cursor })).toThrow(/not a diagram cursor/);
  });

  it('refuses a mixed-view story instead of discarding or guessing flow steps', () => {
    const file = build({ nodes: [{ id: 'system', type: 'service', label: 'Orders' }, { id: 'client', type: 'service', label: 'Client' }, { id: 'api', type: 'api', label: 'API' }, { id: 'db', type: 'database', label: 'DB' }], relationships: [{ id: 'entry', from: 'client', to: 'api' }, { id: 'r', from: 'api', to: 'db' }], flows: [{ id: 'f', title: 'Order', steps: ['entry', 'r'] }] });
    expect(() => applyUpdate(file, [], [{ op: 'moveInside', owner: 'system', ids: ['api', 'db'] }], undefined)).toThrow(/split that story/);
    expect(file.flows[0]?.steps).toHaveLength(2);
  });

  it('can render a bounded focus and one-hop context without taking a transitive closure', () => {
    const file = base();
    file.nodes.push(node('worker', 1000));
    file.edges.push(createEdge({ id: 'rw', source: 'db', target: 'worker' }));
    expect([...renderFocus(file, { nodes: ['api'], neighbors: true })!]).toEqual(['api', 'db']);
    expect(() => renderFocus(file, { nodes: ['missing'] })).toThrow();
  });

  it('honours an explicit fallback type while refusing unsupported types without one', () => {
    const request = { requestId: 'fallback', title: 'Unknown system', nodes: [{ id: 'custom', type: 'custom-runtime', label: 'Runtime' }], fallbackType: 'service' };
    expect(() => validateToolInput('create_diagram', request)).not.toThrow();
    expect(build(request).nodes[0]?.type).toBe('service');
    expect(() => build({ ...request, fallbackType: undefined })).toThrow(/unknown type/);
  });

  it('publishes output contracts and rejects invalid patches through the advertised input schema', () => {
    const tool = TOOLS.find((t) => t.name === 'read_diagram')!;
    expect(schemaProblems(tool.outputSchema, read(base()))).toEqual([]);
    expect(schemaProblems(tool.outputSchema, { diagramId: 'd', revision: 'f:1' }).length).toBeGreaterThan(0);
    expect(() => validateToolInput('update_diagram', { requestId: 'r', diagramId: 'd', expectedRevision: 'f:1', ops: [{ op: 'update', id: 'api', set: { technlogy: 'Rust' } }] })).toThrow();
    expect(() => validateToolInput('update_diagram', { requestId: 'r', diagramId: 'd', expectedRevision: 'f:1', previewId: 'p', ops: [] })).toThrow();
  });
});
