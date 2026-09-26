import { beforeEach, describe, expect, it } from 'vitest';
import {
  addOpenPoint,
  addOpenPointTargets,
  createOpenPoint,
  kindsAmong,
  normalizeOpenPointText,
  pruneOpenPoints,
  removeOpenPoint,
  removeOpenPointTarget,
  reopenOpenPoint,
  resolveOpenPoint,
  retargetOpenPoints,
  setOpenPointContext,
  setOpenPointKind,
  unresolvedOpenPoints,
  unresolvedOpenPointsFor,
} from '../src/document/openPoints';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { addEdges, addNodes, extractFragment, pasteFragment, removeElements, setParent } from '../src/document/operations';
import { decodeClipboard, encodeClipboard } from '../src/document/clipboardCodec';
import { CURRENT_VERSION, DRAFT_FORMAT, type DraftDocument, type OpenPoint } from '../src/document/types';
import { parseDocument } from '../src/document/validate';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { embed, viewOf } from '../src/depth/tree';
import { renderDocumentSvg } from '../src/render/svg/document';
import { describeMarker, describeMarkerKey, edgeMarkerCenter, nodeMarkerOrigin } from '../src/openPoints/marker';
import { openPointsOverview, unresolvedTargetsIn } from '../src/openPoints/collect';
import { DARK } from '../src/render/theme/tokens';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

function scene() {
  const api = createNode({ type: 'service', x: 0, y: 0, text: 'Payment Service' });
  const ledger = createNode({ type: 'database', x: 400, y: 0, text: 'Ledger' });
  const boundary = createNode({ type: 'group', x: -40, y: -40, width: 700, height: 300, text: 'Payments' });
  api.parentId = boundary.id;
  ledger.parentId = boundary.id;
  const call = createEdge({ source: api.id, target: ledger.id, label: 'writes' });
  let doc = addNodes(createDocument('Open points'), [boundary, api, ledger]);
  doc = addEdges(doc, [call]);
  return { doc, api, ledger, boundary, call };
}

function raise(doc: DraftDocument, kind: OpenPoint['kind'], targets: OpenPoint['targets'], context?: string) {
  const point = createOpenPoint(kind, targets, context);
  if (!point) throw new Error('expected a point');
  return { doc: addOpenPoint(doc, point), point };
}

describe('the model', () => {
  it('refuses a point about nothing, and de-duplicates and caps what it is about', () => {
    expect(createOpenPoint('tentative', [])).toBeNull();
    const many = Array.from({ length: LIMITS.maxOpenPointTargets + 5 }, (_, i) => ({ kind: 'node' as const, id: `n${i}` }));
    const point = createOpenPoint('parked', [...many, many[0]!]);
    expect(point?.targets).toHaveLength(LIMITS.maxOpenPointTargets);
  });

  it('keeps context as typed apart from control characters, blank-line runs and the cap', () => {
    expect(normalizeOpenPointText('  Confirm sync vs async\n\n\n\nRough estimate: days \u0007 ')).toBe('Confirm sync vs async\n\nRough estimate: days');
    expect(normalizeOpenPointText('x'.repeat(LIMITS.maxOpenPointContextLength + 20))).toHaveLength(LIMITS.maxOpenPointContextLength);
    const { doc, point } = raise(scene().doc, 'tentative', [{ kind: 'node', id: 'a' }], '   ');
    expect(point.context).toBeUndefined();
    expect(setOpenPointContext(doc, point.id, 'Confirm').openPoints[0]!.context).toBe('Confirm');
    expect(Object.hasOwn(setOpenPointContext(setOpenPointContext(doc, point.id, 'Confirm'), point.id, '  ').openPoints[0]!, 'context')).toBe(false);
  });

  it('returns the same document when nothing changed, so no dead undo step is made', () => {
    const { doc, point } = raise(scene().doc, 'awaiting', [{ kind: 'node', id: 'a' }], 'Ask the team');
    expect(setOpenPointKind(doc, point.id, 'awaiting')).toBe(doc);
    expect(setOpenPointContext(doc, point.id, 'Ask the team')).toBe(doc);
    expect(reopenOpenPoint(doc, point.id)).toBe(doc);
    expect(removeOpenPoint(doc, 'nope')).toBe(doc);
    expect(addOpenPointTargets(doc, point.id, [{ kind: 'node', id: 'a' }])).toBe(doc);
    expect(pruneOpenPoints(doc, new Set(['zzz']), new Set())).toBe(doc);
  });

  it('resolves without touching what it is about, keeps the point, and reopens keeping the note', () => {
    const { doc, api } = scene();
    const raised = raise(doc, 'tentative', [{ kind: 'node', id: api.id }], 'Sync or async?');
    const resolved = resolveOpenPoint(raised.doc, raised.point.id, 'Agreed on async');
    expect(resolved.nodes).toBe(raised.doc.nodes);
    expect(resolved.edges).toBe(raised.doc.edges);
    expect(resolved.openPoints[0]).toMatchObject({ resolved: true, resolution: 'Agreed on async', context: 'Sync or async?' });
    expect(unresolvedOpenPoints(resolved)).toHaveLength(0);
    const reopened = reopenOpenPoint(resolved, raised.point.id);
    expect(Object.hasOwn(reopened.openPoints[0]!, 'resolved')).toBe(false);
    expect(reopened.openPoints[0]!.resolution).toBe('Agreed on async');
    // Resolving again with no note keeps the earlier one.
    expect(resolveOpenPoint(reopened, raised.point.id).openPoints[0]!.resolution).toBe('Agreed on async');
  });

  it('refuses past the cap instead of dropping the oldest', () => {
    let full = scene().doc;
    for (let i = 0; i < LIMITS.maxOpenPoints; i += 1) full = raise(full, 'parked', [{ kind: 'node', id: `n${i}` }]).doc;
    const refused = raise(full, 'parked', [{ kind: 'node', id: 'late' }]);
    expect(refused.doc.openPoints).toHaveLength(LIMITS.maxOpenPoints);
    expect(refused.doc.openPoints[0]!.targets[0]!.id).toBe('n0');
  });

  it('indexes unresolved points per element, identity-stable for an unchanged document', () => {
    const { doc, api, call } = scene();
    const one = raise(doc, 'tentative', [{ kind: 'node', id: api.id }, { kind: 'edge', id: call.id }]);
    const two = raise(one.doc, 'awaiting', [{ kind: 'node', id: api.id }]);
    const forApi = unresolvedOpenPointsFor(two.doc.openPoints, { kind: 'node', id: api.id });
    expect(forApi.map((p) => p.id)).toEqual([one.point.id, two.point.id]);
    expect(unresolvedOpenPointsFor(two.doc.openPoints, { kind: 'node', id: api.id })).toBe(forApi);
    expect(unresolvedOpenPointsFor(two.doc.openPoints, { kind: 'edge', id: call.id })).toHaveLength(1);
    expect(unresolvedOpenPointsFor(two.doc.openPoints, { kind: 'node', id: 'nobody' })).toHaveLength(0);
    const settled = resolveOpenPoint(two.doc, one.point.id);
    expect(unresolvedOpenPointsFor(settled.openPoints, { kind: 'edge', id: call.id })).toHaveLength(0);
    expect(kindsAmong(two.doc.openPoints)).toEqual(['tentative', 'awaiting']);
  });
});

describe('deleting what a point is about', () => {
  it('drops the attachment and, with the last one, the point — in the same operation', () => {
    const { doc, api, ledger, call } = scene();
    const shared = raise(doc, 'awaiting', [{ kind: 'node', id: api.id }, { kind: 'node', id: ledger.id }], 'Confirm the interface');
    const onEdge = raise(shared.doc, 'tentative', [{ kind: 'edge', id: call.id }]);
    const afterApi = removeElements(onEdge.doc, [api.id]);
    // The connector went with the node, so the point about it went too; the shared one stays on Ledger.
    expect(afterApi.openPoints).toHaveLength(1);
    expect(afterApi.openPoints[0]).toMatchObject({ id: shared.point.id, context: 'Confirm the interface', targets: [{ kind: 'node', id: ledger.id }] });
    const afterBoth = removeElements(afterApi, [ledger.id]);
    expect(afterBoth.openPoints).toHaveLength(0);
  });

  it('deleting a boundary takes points about its contents with it, but a point about a member survives ungroup', () => {
    const { doc, api, boundary } = scene();
    const onMember = raise(doc, 'parked', [{ kind: 'node', id: api.id }]);
    const onBoundary = raise(onMember.doc, 'tentative', [{ kind: 'node', id: boundary.id }]);
    expect(removeElements(onBoundary.doc, [boundary.id]).openPoints).toHaveLength(0);
    // Ungroup in the store: only the boundary goes.
    useEditorStore.setState({ document: onBoundary.doc, path: [], outer: null, history: { past: [], future: [] }, selection: { nodes: [boundary.id], edges: [] }, revision: 0 });
    useEditorStore.getState().ungroupSelection();
    const after = useEditorStore.getState().document;
    expect(after.nodes.some((n) => n.id === boundary.id)).toBe(false);
    expect(after.openPoints.map((p) => p.id)).toEqual([onMember.point.id]);
  });

  it('reaches into a removed shape\'s rooms', () => {
    const inner = createNode({ type: 'service', x: 0, y: 0, text: 'Inside' });
    const owner = createNode({ type: 'service', x: 0, y: 0, text: 'Owner' });
    owner.inside = { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const doc = addNodes(createDocument('Deep'), [owner]);
    const raised = raise(doc, 'awaiting', [{ kind: 'node', id: inner.id }]);
    expect(removeElements(raised.doc, [owner.id]).openPoints).toHaveLength(0);
  });

  it('follows a connector replaced by inserting a worker', () => {
    const { doc, api, ledger, call } = scene();
    const raised = raise(doc, 'tentative', [{ kind: 'edge', id: call.id }], 'Async?');
    const moved = retargetOpenPoints(raised.doc, { kind: 'edge', id: call.id }, { kind: 'edge', id: 'e_new' });
    expect(moved.openPoints[0]!.targets).toEqual([{ kind: 'edge', id: 'e_new' }]);
    useEditorStore.setState({ document: raised.doc, path: [], outer: null, history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, revision: 0 });
    useEditorStore.getState().insertWorkerOnEdge(call.id);
    const after = useEditorStore.getState().document;
    const leg = after.edges.find((e) => e.source === api.id)!;
    expect(leg.target).not.toBe(ledger.id);
    expect(after.openPoints[0]!.targets).toEqual([{ kind: 'edge', id: leg.id }]);
  });

  it('detaching one element from a shared point keeps the rest; the last one takes the point', () => {
    const { doc, api, ledger } = scene();
    const shared = raise(doc, 'awaiting', [{ kind: 'node', id: api.id }, { kind: 'node', id: ledger.id }]);
    const one = removeOpenPointTarget(shared.doc, shared.point.id, { kind: 'node', id: api.id });
    expect(one.openPoints[0]!.targets).toEqual([{ kind: 'node', id: ledger.id }]);
    expect(removeOpenPointTarget(one, shared.point.id, { kind: 'node', id: ledger.id }).openPoints).toHaveLength(0);
  });
});

describe('the file', () => {
  it('round-trips through .draftcanvas with every field', () => {
    const { doc, api, call } = scene();
    const raised = raise(doc, 'awaiting', [{ kind: 'node', id: api.id }, { kind: 'edge', id: call.id }], 'Confirm\n\nthe interface');
    const settled = resolveOpenPoint(raised.doc, raised.point.id, 'Agreed');
    const back = deserializeDocument(serializeDocument(settled));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.document.openPoints).toEqual(settled.openPoints);
  });

  it('opens an older file unchanged, with no points and the version moved', () => {
    const raw = JSON.stringify({
      format: DRAFT_FORMAT,
      version: 15,
      metadata: { id: 'd1', title: 'Old', createdAt: 1, updatedAt: 2 },
      nodes: [{ id: 'n1', type: 'service', x: 0, y: 0, width: 160, height: 60, z: 0, text: 'Api' }],
      edges: [],
      flows: [],
      actions: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const result = parseDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.openPoints).toEqual([]);
    expect(result.document.nodes[0]!.text).toBe('Api');
  });

  it('repairs rather than rejects: unknown kinds, dangling attachments and pointless points are dropped, shared ones trimmed', () => {
    const raw = JSON.stringify({
      format: DRAFT_FORMAT,
      version: CURRENT_VERSION,
      metadata: { id: 'd1', title: 'Repair', createdAt: 1, updatedAt: 2 },
      nodes: [{ id: 'n1', type: 'service', x: 0, y: 0, width: 160, height: 60, z: 0 }],
      edges: [],
      flows: [],
      actions: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      openPoints: [
        { id: 'op1', kind: 'tentative', targets: [{ kind: 'node', id: 'n1' }, { kind: 'edge', id: 'gone' }], context: 'keep\u0000me', resolved: true, resolution: 'ok' },
        { id: 'op2', kind: 'confident', targets: [{ kind: 'node', id: 'n1' }] },
        { id: 'op3', kind: 'parked', targets: [{ kind: 'node', id: 'nobody' }] },
        { id: 'op4', kind: 'awaiting', targets: [] },
        'junk',
      ],
    });
    const result = parseDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.openPoints).toEqual([
      { id: 'op1', kind: 'tentative', targets: [{ kind: 'node', id: 'n1' }], context: 'keepme', resolved: true, resolution: 'ok' },
    ]);
    expect(result.repairs.join(' ')).toMatch(/open point/);
  });

  it('is root-only: a room carrying its own list is ignored, and a point raised inside is carried home', () => {
    const inner = createNode({ type: 'service', x: 0, y: 0, text: 'Inside' });
    const owner = createNode({ type: 'service', x: 0, y: 0, text: 'Owner' });
    owner.inside = { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const file = addNodes(createDocument('Deep'), [owner]);
    const room = viewOf(file, [owner.id])!;
    expect(room.openPoints).toBe(file.openPoints);
    const raised = raise(room, 'tentative', [{ kind: 'node', id: inner.id }]);
    const home = embed(file, [owner.id], raised.doc);
    expect(home.openPoints).toEqual(raised.doc.openPoints);
    expect(home.nodes[0]!.inside).toBeDefined();
    expect((home.nodes[0]!.inside as unknown as { openPoints?: unknown }).openPoints).toBeUndefined();
    // And a room read back from disk never merges one upward.
    const smuggled = JSON.parse(serializeDocument(home));
    smuggled.nodes[0].inside.openPoints = [{ id: 'x', kind: 'parked', targets: [{ kind: 'node', id: inner.id }] }];
    const parsed = parseDocument(JSON.stringify(smuggled));
    expect(parsed.ok && parsed.document.openPoints.map((p) => p.id)).toEqual([raised.point.id]);
  });
});

describe('copy, paste and duplicate', () => {
  it('carries a point with the copied fragment, re-identified and re-pointed, trimmed to what was copied', () => {
    const { doc, api, ledger, call } = scene();
    const shared = raise(doc, 'awaiting', [{ kind: 'node', id: api.id }, { kind: 'node', id: ledger.id }, { kind: 'edge', id: call.id }], 'Confirm');
    const fragment = extractFragment(shared.doc, [api.id]);
    expect(fragment.openPoints).toHaveLength(1);
    expect(fragment.openPoints![0]!.targets).toEqual([{ kind: 'node', id: api.id }]);
    const pasted = pasteFragment(shared.doc, fragment, { x: 40, y: 40 });
    expect(pasted.doc.openPoints).toHaveLength(2);
    const copy = pasted.doc.openPoints[1]!;
    expect(copy.id).not.toBe(shared.point.id);
    expect(copy.context).toBe('Confirm');
    expect(copy.targets).toEqual([{ kind: 'node', id: pasted.nodeIds[0] }]);
    // The original is exactly as it was.
    expect(pasted.doc.openPoints[0]).toEqual(shared.point);
  });

  it('survives the system clipboard, with a connector re-pointed too', () => {
    const { doc, api, ledger, call } = scene();
    const raised = raise(doc, 'tentative', [{ kind: 'edge', id: call.id }], 'Async?');
    const fragment = extractFragment(raised.doc, [api.id, ledger.id]);
    const decoded = decodeClipboard(encodeClipboard(fragment));
    expect(decoded?.openPoints).toHaveLength(1);
    const pasted = pasteFragment(raised.doc, decoded!, { x: 0, y: 500 });
    expect(pasted.doc.openPoints[1]!.targets).toEqual([{ kind: 'edge', id: pasted.edgeIds[0] }]);
  });

  it('a fragment copied without a marked element carries no point', () => {
    const { doc, api, ledger } = scene();
    const raised = raise(doc, 'parked', [{ kind: 'node', id: ledger.id }]);
    expect(extractFragment(raised.doc, [api.id]).openPoints).toBeUndefined();
  });
});

describe('in the store', () => {
  const store = useEditorStore;
  beforeEach(() => {
    __resetInteraction();
    __resetClipboardSync();
    const { doc } = scene();
    store.setState({ document: doc, path: [], outer: null, liveViewport: null, history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, clipboard: null, pasteRepeat: 0, revision: 0 });
    useUiStore.setState({ openPointPopover: null, openPointsPanelOpen: false });
  });

  it('raising, editing, resolving, reopening and deleting are ordinary undoable edits', () => {
    const api = store.getState().document.nodes.find((n) => n.text === 'Payment Service')!;
    const id = store.getState().addOpenPoint('tentative', [{ kind: 'node', id: api.id }])!;
    expect(id).toBeTruthy();
    expect(store.getState().history.past).toHaveLength(1);
    store.getState().setOpenPointKind(id, 'parked');
    store.getState().resolveOpenPoint(id, 'Later');
    expect(store.getState().document.openPoints[0]).toMatchObject({ kind: 'parked', resolved: true, resolution: 'Later' });
    store.getState().undo();
    expect(store.getState().document.openPoints[0]!.resolved).toBeUndefined();
    store.getState().undo();
    expect(store.getState().document.openPoints[0]!.kind).toBe('tentative');
    store.getState().redo();
    store.getState().redo();
    store.getState().reopenOpenPoint(id);
    store.getState().removeOpenPoint(id);
    expect(store.getState().document.openPoints).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().document.openPoints).toHaveLength(1);
  });

  it('coalesces typing into one undo step, and drops a burst that nets out', () => {
    const api = store.getState().document.nodes[1]!;
    const id = store.getState().addOpenPoint('awaiting', [{ kind: 'node', id: api.id }])!;
    const entries = store.getState().history.past.length;
    store.getState().setOpenPointContext(id, 'C');
    store.getState().setOpenPointContext(id, 'Co');
    store.getState().setOpenPointContext(id, 'Confirm');
    expect(store.getState().history.past).toHaveLength(entries + 1);
    store.getState().undo();
    expect(store.getState().document.openPoints[0]!.context).toBeUndefined();
  });

  it('deleting the last element a point is about removes the point in the same step, and undo restores both', () => {
    const api = store.getState().document.nodes.find((n) => n.text === 'Payment Service')!;
    store.getState().addOpenPoint('tentative', [{ kind: 'node', id: api.id }], 'Sync?');
    store.getState().setSelection({ nodes: [api.id], edges: [] });
    const before = store.getState().history.past.length;
    store.getState().deleteSelection();
    expect(store.getState().history.past).toHaveLength(before + 1);
    expect(store.getState().document.openPoints).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().document.nodes.some((n) => n.id === api.id)).toBe(true);
    expect(store.getState().document.openPoints[0]!.context).toBe('Sync?');
  });

  it('duplicating a marked shape gives the copy its own point', () => {
    const api = store.getState().document.nodes.find((n) => n.text === 'Payment Service')!;
    store.getState().addOpenPoint('parked', [{ kind: 'node', id: api.id }]);
    store.getState().setSelection({ nodes: [api.id], edges: [] });
    store.getState().duplicateSelection();
    const { openPoints, nodes } = store.getState().document;
    expect(openPoints).toHaveLength(2);
    expect(openPoints[1]!.targets[0]!.id).toBe(nodes.at(-1)!.id);
    expect(new Set(openPoints.map((p) => p.id)).size).toBe(2);
  });

  it('a new document leaves nothing behind: the popover closes with the canvas it was about', () => {
    const api = store.getState().document.nodes[1]!;
    useUiStore.getState().setOpenPointPopover({ anchor: { kind: 'node', id: api.id }, targets: [{ kind: 'node', id: api.id }], creating: true });
    store.getState().setDocument(createDocument('Other'));
    expect(useUiStore.getState().openPointPopover).toBeNull();
    expect(store.getState().document.openPoints).toEqual([]);
  });
});

describe('the marker', () => {
  it('draws a distinct glyph per kind, one accent, and a count for several', () => {
    const one = describeMarker([{ id: 'a', kind: 'tentative', targets: [] }], { theme: DARK });
    const two = describeMarker([{ id: 'a', kind: 'awaiting', targets: [] }], { theme: DARK });
    const three = describeMarker([{ id: 'a', kind: 'parked', targets: [] }], { theme: DARK });
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
    expect(JSON.stringify(two)).not.toBe(JSON.stringify(three));
    const several = describeMarker([{ id: 'a', kind: 'tentative', targets: [] }, { id: 'b', kind: 'parked', targets: [] }], { theme: DARK });
    const text = several.find((s) => s.t === 'text');
    expect(text && text.t === 'text' ? text.layout.lines[0]!.text : '').toBe('2');
  });

  it('sits off a shape\'s shoulder, inside a boundary\'s corner, and beside a connector\'s words', () => {
    // Off the shoulder: outside the box on the right, mostly above its top edge.
    const shoulder = nodeMarkerOrigin({ type: 'service', width: 176, height: 68 });
    expect(shoulder.x).toBeGreaterThan(176);
    expect(shoulder.y).toBeLessThan(0);
    // Inside a boundary's own empty corner.
    const inside = nodeMarkerOrigin({ type: 'group', width: 420, height: 300 });
    expect(inside.x + 16).toBeLessThan(420);
    expect(inside.y).toBeGreaterThan(0);
    const beside = edgeMarkerCenter({ x: 100, y: 100 }, 'top', { left: 80, top: 80, width: 40, height: 14 });
    expect(beside).toEqual({ x: 80 + 40 + 4 + 8, y: 87 });
    const leftward = edgeMarkerCenter({ x: 100, y: 100 }, 'left', { left: 40, top: 93, width: 50, height: 14 });
    expect(leftward.x).toBeLessThan(40);
    expect(edgeMarkerCenter({ x: 100, y: 100 }, 'top')).toEqual({ x: 100, y: 84 });
  });

  it('names only the kinds present in the key', () => {
    const key = describeMarkerKey([{ id: 'a', kind: 'parked', targets: [] }], { theme: DARK });
    expect(key).not.toBeNull();
    const words = key!.shapes.filter((s) => s.t === 'text').map((s) => (s.t === 'text' ? s.layout.lines[0]!.text : ''));
    expect(words).toEqual(['Open points', 'Parked']);
    expect(describeMarkerKey([], { theme: DARK })).toBeNull();
  });
});

describe('the export', () => {
  it('keeps markers and a key by default, leaves both out when asked, and never clips them', () => {
    const { doc, api, call } = scene();
    const raised = raise(raise(doc, 'tentative', [{ kind: 'node', id: api.id }]).doc, 'awaiting', [{ kind: 'edge', id: call.id }]);
    const withMarkers = renderDocumentSvg(raised.doc, { theme: 'light' });
    const without = renderDocumentSvg(raised.doc, { theme: 'light', openPoints: false });
    expect(withMarkers.svg).toContain('Open points');
    expect(withMarkers.svg).toContain('Tentative');
    expect(withMarkers.svg).toContain('Awaiting input');
    expect(withMarkers.svg).not.toContain('Parked');
    expect(without.svg).not.toContain('Open points');
    expect(withMarkers.height).toBeGreaterThan(without.height);
    // A resolved point leaves no trace in the picture.
    const settled = raised.doc.openPoints.reduce((d, p) => resolveOpenPoint(d, p.id), raised.doc);
    expect(renderDocumentSvg(settled, { theme: 'light' }).svg).not.toContain('Open points');
  });

  it('a selection-only export of an unmarked corner carries no key', () => {
    const { doc, api, ledger } = scene();
    const raised = raise(doc, 'parked', [{ kind: 'node', id: api.id }]);
    const only = renderDocumentSvg(raised.doc, { only: new Set([ledger.id]) });
    expect(only.svg).not.toContain('Open points');
  });
});

describe('the overview', () => {
  it('names what each point is about, wherever it lives, and lists the unresolved elements of a room', () => {
    const { doc, api, call, boundary } = scene();
    const one = raise(doc, 'awaiting', [{ kind: 'node', id: api.id }, { kind: 'edge', id: call.id }], 'Confirm');
    const two = raise(one.doc, 'parked', [{ kind: 'node', id: boundary.id }]);
    const settled = resolveOpenPoint(two.doc, two.point.id);
    const overview = openPointsOverview(settled);
    expect(overview.open.map((row) => row.targets.map((t) => t.label))).toEqual([['Payment Service', 'Payment Service → Ledger']]);
    expect(overview.resolved.map((row) => row.point.id)).toEqual([two.point.id]);
    expect(unresolvedTargetsIn(settled)).toEqual({ nodeIds: [api.id], edgeIds: [call.id] });
    // Grouping a marked shape under a new boundary touches nothing about the point.
    const grouped = setParent(settled, [api.id], boundary.id);
    expect(grouped.openPoints).toBe(settled.openPoints);
  });
});
