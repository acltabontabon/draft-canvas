/**
 * What the editor writes is what a reload keeps: settings, texts, titles, cameras and numbers are held
 * to the loader's rules at the moment they are written, a write that changes nothing leaves no undo
 * step, and a file with repeated ids says what it did about them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode, cloneDocumentAsNew } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { addEdges, addNodes, setSettings, setTitle, setViewport, updateNode } from '../src/document/operations';
import { cleanTitle, titleWithSuffix } from '../src/document/sanitize';
import { parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { HISTORY_LIMIT, pushEntry, type HistoryEntry } from '../src/history/HistoryStack';
import { __resetInteraction, fileOf, useEditorStore } from '../src/store/editorStore';

const store = useEditorStore;

function reset(document = createDocument('Hygiene')) {
  __resetInteraction();
  store.setState({
    document,
    path: [],
    outer: null,
    liveViewport: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
  });
}

/** What opening the saved file would make of it. */
function reloaded() {
  const result = parseDocument(serializeDocument(fileOf(store.getState())));
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe('canvas settings', () => {
  beforeEach(() => reset());

  it('re-picking what is already picked records nothing', () => {
    const before = store.getState().document;
    store.getState().updateSettings({ grid: 'dots' });
    store.getState().updateSettings({ showSequence: true });
    store.getState().updateSettings({ background: { ...before.settings.background } });
    expect(store.getState().document).toBe(before);
    expect(store.getState().history.past).toHaveLength(0);
    // A real change still is one, and undoes.
    store.getState().updateSettings({ grid: 'lines' });
    expect(store.getState().history.past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().document.settings.grid).toBe('dots');
  });

  it('is held to what a load keeps, silently: a scrim and a blur between 0 and 1, a grid that exists', () => {
    const { background } = store.getState().document.settings;
    store.getState().updateSettings({ background: { ...background, dim: 5, blur: -2 } });
    expect(store.getState().document.settings.background).toMatchObject({ dim: 1, blur: 0 });
    store.getState().updateSettings({ grid: 'weird' as never });
    expect(store.getState().document.settings.grid).toBe('dots');
    store.getState().updateSettings({ background: { ...background, dim: Number.NaN, fit: 'sideways' as never } });
    expect(store.getState().document.settings.background).toMatchObject({ dim: 1, fit: 'cover' });
    // What is stored is what opens: no repair, nothing changed.
    const result = reloaded();
    expect(result.repairs).toEqual([]);
    expect(result.document.settings).toEqual(store.getState().document.settings);
  });

  it('keeps an image id and drops one that is not one', () => {
    const { background } = store.getState().document.settings;
    const doc = createDocument('x');
    expect(setSettings(doc, { background: { ...background, enabled: true, imageId: 'bg_1' } }).settings.background.imageId).toBe('bg_1');
    expect(setSettings(doc, { background: { ...background, imageId: ' '.repeat(3) } }).settings.background.imageId).toBeUndefined();
  });
});

describe('connector labels', () => {
  function connected() {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    return store.getState().connect(a.id, b.id)!;
  }
  beforeEach(() => reset());

  it('are trimmed, and nothing left means no label at all', () => {
    const edge = connected();
    const edgeNow = () => store.getState().document.edges.find((e) => e.id === edge.id)!;
    store.getState().updateEdgeLabel(edge.id, '  reads  ');
    expect(edgeNow().label).toBe('reads');
    store.getState().updateEdgeLabel(edge.id, '   ');
    expect('label' in edgeNow()).toBe(false);
    store.getState().updateEdgeLabel(edge.id, 'writes');
    store.getState().updateEdgeLabel(edge.id, '');
    expect('label' in edgeNow()).toBe(false);
    expect(reloaded().document.edges[0]).toEqual(edgeNow());
  });

  it('committing blank over no label, or the same words with space around them, records nothing', () => {
    const edge = connected();
    const unlabeled = store.getState().document;
    const steps = store.getState().history.past.length;
    store.getState().updateEdgeLabel(edge.id, '');
    store.getState().updateEdgeLabel(edge.id, '   ');
    expect(store.getState().document).toBe(unlabeled);
    expect(store.getState().history.past).toHaveLength(steps);
    store.getState().updateEdgeLabel(edge.id, 'reads');
    const labeled = store.getState().document;
    store.getState().updateEdgeLabel(edge.id, ' reads ');
    expect(store.getState().document).toBe(labeled);
  });

  it('a file with a blank or padded label opens trimmed, and without the blank one', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 300, y: 0 });
    const doc = addEdges(addNodes(createDocument('Labels'), [a, b]), [
      { ...createEdge({ id: 'e1', source: 'a', target: 'b' }), label: '  padded  ' },
      { ...createEdge({ id: 'e2', source: 'b', target: 'a' }), label: '   ' },
    ]);
    const result = parseDocument(serializeDocument(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges.map((e) => e.label)).toEqual(['padded', undefined]);
  });

  it('toggling a response that is not there off changes nothing, and does not mark the connector explicit', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Orders' });
    const b = store.getState().addNode({ type: 'service', x: 300, y: 0, text: 'Billing' });
    const edge = store.getState().connect(a.id, b.id)!;
    store.getState().updateEdgeById(edge.id, { semanticsOrigin: 'inferred' });
    const before = store.getState().document;
    const steps = store.getState().history.past.length;
    store.getState().setEdgeHasResponse(edge.id, false);
    expect(store.getState().document).toBe(before);
    expect(store.getState().history.past).toHaveLength(steps);
    // Turning it on is a step; turning it on again is not.
    store.getState().setEdgeHasResponse(edge.id, true);
    expect(store.getState().history.past).toHaveLength(steps + 1);
    const on = store.getState().document;
    store.getState().setEdgeHasResponse(edge.id, true);
    expect(store.getState().document).toBe(on);
    store.getState().setEdgeHasResponse(edge.id, false);
    expect(store.getState().history.past).toHaveLength(steps + 2);
  });
});

describe('text patches to a node', () => {
  beforeEach(() => reset());

  it('are normalized like the inspector and a load do: trimmed, a technology on one line, empty means absent', () => {
    const node = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Orders' });
    const now = () => store.getState().document.nodes.find((n) => n.id === node.id)!;
    store.getState().updateNodeById(node.id, { technology: '  Spring \n  Boot  3 ', description: '  Takes orders.  ' });
    expect(now()).toMatchObject({ technology: 'Spring Boot 3', description: 'Takes orders.' });
    store.getState().updateNodeById(node.id, { technology: '   ', description: '' });
    expect('technology' in now()).toBe(false);
    expect('description' in now()).toBe(false);
    store.getState().updateNodeById(node.id, { technology: 'Go\u0007'.repeat(40) });
    expect(now().technology).toHaveLength(LIMITS.maxTechnologyLength);
    expect(now().technology!.includes('\u0007')).toBe(false);
    expect(reloaded().document.nodes[0]).toEqual(now());
  });

  it('the inspector path and the patch path agree', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 300, y: 0 });
    const input = '  A\t\tB  \n C ';
    store.getState().setNodeC4Text(a.id, { technology: input, description: input });
    store.getState().updateNodeById(b.id, { technology: input, description: input });
    const [first, second] = store.getState().document.nodes;
    expect([first!.technology, first!.description]).toEqual([second!.technology, second!.description]);
  });

  it('keep z and replicas within what a load accepts', () => {
    const node = store.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Orders' });
    const now = () => store.getState().document.nodes.find((n) => n.id === node.id)!;
    store.getState().updateNodeById(node.id, { z: 1e9, replicas: 1e9 });
    expect(now()).toMatchObject({ z: LIMITS.maxZ, replicas: LIMITS.maxReplicas });
    store.getState().updateNodeById(node.id, { z: -1e9, replicas: 1 });
    expect(now().z).toBe(-LIMITS.maxZ);
    expect('replicas' in now()).toBe(false);
    expect(updateNode(createDocument('x'), 'missing', { z: Number.NaN })).toBeDefined();
    store.getState().updateNodeById(node.id, { z: Number.NaN });
    expect(Number.isFinite(now().z)).toBe(true);
    expect(reloaded().document.nodes[0]).toEqual(now());
  });
});

describe('titles', () => {
  it('follow one rule wherever they come from: control characters out, trimmed, then cut', () => {
    expect(cleanTitle('  Orders\u0007 platform  ')).toBe('Orders platform');
    expect(cleanTitle('\u0000\u0001  ')).toBe('Untitled diagram');
    expect(cleanTitle('   ', 'Imported diagram')).toBe('Imported diagram');
    // Leading space never costs a letter: trimmed first, cut second.
    const long = `${' '.repeat(50)}${'x'.repeat(190)}`;
    expect(cleanTitle(long)).toBe('x'.repeat(190));
    expect(cleanTitle('y'.repeat(250))).toHaveLength(LIMITS.maxTitleLength);
    // The cut never ends in a space, and never splits an emoji.
    expect(cleanTitle(`${'a'.repeat(LIMITS.maxTitleLength - 1)} b`)).toBe('a'.repeat(LIMITS.maxTitleLength - 1));
    const emoji = `${'a'.repeat(LIMITS.maxTitleLength - 1)}😀`;
    expect(cleanTitle(emoji)).toBe('a'.repeat(LIMITS.maxTitleLength - 1));
  });

  it('is the same from a rename, a load, and a collaborator', async () => {
    const messy = `\u0007  ${'z'.repeat(260)}  `;
    const renamed = setTitle(createDocument(), messy).metadata.title;
    const loaded = parseDocument(JSON.stringify({ ...JSON.parse(serializeDocument(createDocument())), metadata: { id: 'd_t', title: messy, createdAt: 0, updatedAt: 0 } }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.document.metadata.title).toBe(renamed);
    const { sanitizeChanges } = await import('../src/collab/sanitize');
    const shared = sanitizeChanges([{ kind: 'title', value: messy }]);
    expect(shared).toEqual({ ok: true, changes: [{ kind: 'title', value: renamed }] });
    expect(renamed).toHaveLength(LIMITS.maxTitleLength);
  });

  it('a copy of a 200-character title stays within 200, and still says it is a copy', () => {
    const title = 'T'.repeat(LIMITS.maxTitleLength);
    const copy = titleWithSuffix(title, ' copy');
    expect(copy).toHaveLength(LIMITS.maxTitleLength);
    expect(copy.endsWith(' copy')).toBe(true);
    expect(titleWithSuffix('Orders', ' copy')).toBe('Orders copy');
    const clone = cloneDocumentAsNew(createDocument(title), copy);
    expect(parseDocument(serializeDocument(clone)).ok && (parseDocument(serializeDocument(clone)) as { document: { metadata: { title: string } } }).document.metadata.title).toBe(copy);
  });

  it('a copy keeps where the diagram began, and its project', () => {
    const origin = { starter: 'event-driven', sha256: 'a'.repeat(64) };
    const source = { ...createDocument('From a starter'), metadata: { ...createDocument('x').metadata, title: 'From a starter', projectId: 'p_1', origin } };
    const clone = cloneDocumentAsNew(source, 'From a starter copy');
    expect(clone.metadata.id).not.toBe(source.metadata.id);
    expect(clone.metadata).toMatchObject({ title: 'From a starter copy', projectId: 'p_1', origin });
    expect(clone.metadata.origin).not.toBe(origin);
  });
});

describe('the camera and the numbers it is made of', () => {
  beforeEach(() => reset());

  it('setViewport clamps like a load, and a part that is not a number stays where it was', () => {
    const doc = { ...createDocument('Camera'), viewport: { x: 10, y: 20, zoom: 2 } };
    expect(setViewport(doc, { x: 5e9, y: -5e9, zoom: 100 }).viewport).toEqual({ x: LIMITS.maxCoordinate, y: -LIMITS.maxCoordinate, zoom: LIMITS.maxZoom });
    expect(setViewport(doc, { x: Number.NaN, y: Infinity, zoom: Number.NaN }).viewport).toEqual({ x: 10, y: 20, zoom: 2 });
  });

  it('persistViewport never keeps a camera no file can hold', () => {
    store.getState().persistViewport({ x: 30, y: 60, zoom: 1.5 });
    store.getState().persistViewport({ x: Number.NaN, y: Number.NaN, zoom: Number.NaN });
    expect(store.getState().liveViewport).toEqual({ x: 30, y: 60, zoom: 1.5 });
    store.getState().persistViewport({ x: 1e12, y: 60, zoom: 1.5 });
    expect(store.getState().liveViewport).toEqual({ x: LIMITS.maxCoordinate, y: 60, zoom: 1.5 });
  });
});

describe('history coalescing', () => {
  const entry = (at: number, label = 'Edit'): HistoryEntry => {
    const before = createDocument('H');
    const after = { ...before, metadata: { ...before.metadata, title: `${label} ${at}` } };
    return { label, before, after, path: [], selectionBefore: { nodes: [], edges: [] }, selectionAfter: { nodes: [], edges: [] }, at, coalesceKey: 'k' };
  };

  it('merges edits in quick succession', () => {
    const history = pushEntry(pushEntry({ past: [], future: [] }, entry(1000)), entry(1500));
    expect(history.past).toHaveLength(1);
  });

  it('does not merge across a clock that stepped backwards', () => {
    const history = pushEntry(pushEntry({ past: [], future: [] }, entry(100_000)), entry(99_900));
    expect(history.past).toHaveLength(2);
    // …nor edits more than the window apart.
    expect(pushEntry(pushEntry({ past: [], future: [] }, entry(1000)), entry(2000)).past).toHaveLength(2);
    expect(HISTORY_LIMIT).toBeGreaterThan(2);
  });
});

describe('ids a file repeats', () => {
  it('are reissued, and the repair says so for connectors, flows, steps and attachments', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 300, y: 0 });
    const edge = (id: string, source: string, target: string) => createEdge({ id, source, target });
    const raw = JSON.parse(serializeDocument(addEdges(addNodes(createDocument('Twins'), [a, b]), [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')])));
    raw.edges[1].id = 'e1';
    raw.nodes[0].attachments = [
      { id: 'att', type: 'note', text: 'one' },
      { id: 'att', type: 'note', text: 'two' },
    ];
    raw.flows = [
      { id: 'f', title: 'One', steps: [{ id: 's', edgeId: 'e1' }, { id: 's', extraNodeIds: ['a'] }] },
      { id: 'f', title: 'Two', steps: [] },
    ];
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual(
      expect.arrayContaining([
        'Gave 1 attachment(s) new ids (missing or duplicate).',
        'Gave 1 connector(s) new ids (missing or duplicate).',
        'Gave 1 flow(s) new ids (missing or duplicate).',
        'Gave 1 flow step(s) new ids (missing or duplicate).',
      ]),
    );
    expect(new Set(result.document.edges.map((e) => e.id)).size).toBe(2);
    expect(new Set(result.document.flows.map((f) => f.id)).size).toBe(2);
    // Nothing is said when nothing was repeated.
    expect(parseDocument(serializeDocument(addNodes(createDocument('Fine'), [a]))).ok).toBe(true);
    const fine = parseDocument(serializeDocument(addEdges(addNodes(createDocument('Fine'), [a, b]), [edge('e1', 'a', 'b')])));
    expect(fine.ok && fine.repairs).toEqual([]);
  });
});
