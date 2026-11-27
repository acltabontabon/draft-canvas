import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
import { historyText } from '../../src/evolution/snapshot';
import { blobId } from '../../src/evolution/hash';
import { operationRecord } from '../../src/evolution/journal';
import { branchOf, MAIN_REF } from '../../src/evolution/refs';
import { parseMessage } from '../../src/evolution/trailers';
import { attachHistory, detachHistory, duplicateHistory, hasHistory, historyService } from '../../src/store/evolution/bridge';
import { cloneDocumentAsNew } from '../../src/document/factory';
import { useEvolutionStore } from '../../src/store/evolution/evolutionStore';
import { createAlternative, recoverOperations, restoreElements, restoreRevision, switchAlternative } from '../../src/store/evolution/operations';
import { fileOf, useEditorStore } from '../../src/store/editorStore';
import { semanticDiff } from '../../src/evolution/diff';
import { historyContent } from '../../src/document/content';
import { readHistoryText } from '../../src/evolution/snapshot';

/** Web Locks for jsdom: one process, held until released. */
beforeAll(() => {
  const held = new Map<string, Promise<void>>();
  const locks = {
    async request(name: string, options: { ifAvailable?: boolean }, run: (lock: unknown) => Promise<void> | void) {
      if (options.ifAvailable && held.has(name)) return run(null);
      const before = held.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      held.set(name, before.then(() => mine));
      await before;
      try {
        return await run({ name });
      } finally {
        release();
        if (held.get(name) === mine) held.delete(name);
      }
    },
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
});

afterEach(async () => {
  await detachHistory();
});

let counter = 0;
async function start() {
  counter += 1;
  const doc = addNodes(createDocument(`Ops ${counter}`), [createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' })]);
  useEditorStore.getState().setDocument(doc);
  await attachHistory({ kind: 'library', documentId: doc.metadata.id });
  await historyService().flush();
  return doc;
}

async function edit(recipe: Parameters<ReturnType<typeof useEditorStore.getState>['applyToFile']>[1], label = 'Edit') {
  expect(useEditorStore.getState().applyToFile(label, recipe)).toBe(true);
  await historyService().flush();
}

async function tipOf(ref = MAIN_REF) {
  return (await historyService().store!.readRef(ref))!;
}

describe('restoring', { timeout: 30_000 }, () => {
  it('restores a revision as a new revision, losslessly, as one undo step', async () => {
    await start();
    const first = await tipOf();
    await edit((file) => addNodes(file, [createNode({ type: 'database', x: 0, y: 200, id: 'n_db', text: 'PostgreSQL' })]));
    const second = await tipOf();
    const outcome = await restoreRevision(first);
    expect(outcome.ok).toBe(true);
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id)).toEqual(['n_api']);
    const tip = await tipOf();
    const commit = await historyService().store!.readCommit(tip);
    expect(commit.parents).toEqual([second]);
    expect(parseMessage(commit.message).trailers).toMatchObject({ initiator: 'restore', restoredFrom: first });
    // Everything recorded before is still there.
    expect((await historyService().store!.log({ from: [tip], limit: 10 })).map((c) => c.oid)).toContain(second);
    useEditorStore.getState().undo();
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id)).toEqual(['n_api', 'n_db']);
  });

  it('brings back one removed shape and the connectors that need it', async () => {
    await start();
    await edit((file) => addNodes(file, [createNode({ type: 'database', x: 0, y: 200, id: 'n_db', text: 'PostgreSQL' })]));
    const withDb = await tipOf();
    await edit((file) => ({ ...file, nodes: file.nodes.filter((node) => node.id !== 'n_db') }));
    await edit((file) => updateNode(file, 'n_api', { text: 'Edge' }));
    const before = readHistoryText(await historyService().store!.readSnapshot(withDb)).document;
    const diff = semanticDiff(historyContent(fileOf(useEditorStore.getState())), before);
    const db = diff.elements.find((change) => change.id === 'n_db')!;
    const outcome = await restoreElements(withDb, [db]);
    expect(outcome.ok).toBe(true);
    const now = fileOf(useEditorStore.getState());
    expect(now.nodes.map((node) => node.id).sort()).toEqual(['n_api', 'n_db']);
    // The rest of the diagram is as it was: the rename stays.
    expect(now.nodes.find((node) => node.id === 'n_api')!.text).toBe('Edge');
  });

  const viewport = { x: 0, y: 0, zoom: 1 };
  /** A Service with a room: two shapes and a connector, ink, and a room inside one of them. */
  function serviceWithRoom() {
    const deep = { ...createNode({ type: 'service', x: 0, y: 0, id: 'n_worker', text: 'Worker' }), inside: { nodes: [createNode({ type: 'database', x: 0, y: 0, id: 'n_deep', text: 'Cache' })], edges: [], flows: [], viewport } };
    const inner = [createNode({ type: 'service', x: 0, y: 0, id: 'n_inner', text: 'Handler' }), deep];
    const stroke = { id: 'i_mark', tool: 'pen' as const, color: 'red' as const, size: 2, x: 0, y: 0, points: [0, 0, 10, 10] };
    return {
      ...createNode({ type: 'service', x: 300, y: 0, id: 'n_svc', text: 'Orders' }),
      inside: { nodes: inner, edges: [createEdge({ id: 'e_inner', source: 'n_inner', target: 'n_worker' })], flows: [], ink: [stroke], viewport },
    };
  }

  it('brings back a removed shape with everything inside it', async () => {
    await start();
    await edit((file) => addNodes(file, [serviceWithRoom()]));
    const withRoom = await tipOf();
    await edit((file) => ({ ...file, nodes: file.nodes.filter((node) => node.id !== 'n_svc') }));
    const before = readHistoryText(await historyService().store!.readSnapshot(withRoom)).document;
    const svc = semanticDiff(historyContent(fileOf(useEditorStore.getState())), before).elements.find((change) => change.id === 'n_svc')!;
    const outcome = await restoreElements(withRoom, [svc]);
    expect(outcome.ok).toBe(true);
    // It came back whole once, as a bare box with no room: the room's contents were separate changes
    // the restore never picked.
    const restored = fileOf(useEditorStore.getState()).nodes.find((node) => node.id === 'n_svc')!;
    expect(restored.inside?.nodes.map((node) => node.id)).toEqual(['n_inner', 'n_worker']);
    expect(restored.inside?.edges.map((edge) => edge.id)).toEqual(['e_inner']);
    expect(restored.inside?.ink?.map((stroke) => stroke.id)).toEqual(['i_mark']);
    expect(restored.inside?.nodes.find((node) => node.id === 'n_worker')!.inside?.nodes.map((node) => node.id)).toEqual(['n_deep']);
    useEditorStore.getState().undo();
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id)).toEqual(['n_api']);
  });

  it('restoring a shape that is still here leaves its room as it is now', async () => {
    await start();
    await edit((file) => addNodes(file, [serviceWithRoom()]));
    const withRoom = await tipOf();
    await edit((file) => ({
      ...file,
      nodes: file.nodes.map((node) => (node.id === 'n_svc' ? { ...node, text: 'Checkout', inside: { ...node.inside!, nodes: node.inside!.nodes.map((inner) => (inner.id === 'n_inner' ? { ...inner, text: 'Renamed' } : inner)) } } : node)),
    }));
    const before = readHistoryText(await historyService().store!.readSnapshot(withRoom)).document;
    const svc = semanticDiff(historyContent(fileOf(useEditorStore.getState())), before).elements.find((change) => change.id === 'n_svc')!;
    const outcome = await restoreElements(withRoom, [svc]);
    expect(outcome.ok).toBe(true);
    const now = fileOf(useEditorStore.getState()).nodes.find((node) => node.id === 'n_svc')!;
    expect(now.text).toBe('Orders');
    expect(now.inside!.nodes.find((node) => node.id === 'n_inner')!.text).toBe('Renamed');
  });
});

describe('alternatives', { timeout: 30_000 }, () => {
  it('explores an alternative on its own branch and leaves the main architecture untouched', async () => {
    await start();
    const mainTip = await tipOf();
    const created = await createAlternative('Event-driven');
    expect(created.ok).toBe(true);
    const altId = useEvolutionStore.getState().altId!;
    expect(altId).toBeTruthy();
    await edit((file) => addNodes(file, [createNode({ type: 'queue', x: 300, y: 0, id: 'n_q', text: 'Events' })]));
    expect(await tipOf()).toBe(mainTip);
    const altTip = await tipOf(branchOf(altId));
    expect(altTip).not.toBe(mainTip);
    expect((await historyService().store!.readCommit(altTip)).parents).toEqual([mainTip]);

    const back = await switchAlternative(null);
    expect(back.ok).toBe(true);
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id)).toEqual(['n_api']);
    await switchAlternative(altId);
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id).sort()).toEqual(['n_api', 'n_q']);
  });
});

describe('recovering an interrupted operation', { timeout: 30_000 }, () => {
  it('finishes a restore whose history moved but whose diagram did not', async () => {
    await start();
    const first = await tipOf();
    await edit((file) => addNodes(file, [createNode({ type: 'database', x: 0, y: 200, id: 'n_db', text: 'PostgreSQL' })]));
    const second = await tipOf();
    const store = historyService().store!;
    // A restore that crashed after moving the branch, before touching the diagram.
    const firstText = await store.readSnapshot(first);
    const signature = { name: 'T', email: 't@draftcanvas.invalid', timestamp: 1, timezoneOffset: 0 };
    const restoreCommit = await store.writeSnapshot({ text: firstText, parents: [second], author: signature, committer: signature, message: 'Restore\n' });
    await store.updateRef({ ref: MAIN_REF, expected: second, next: restoreCommit });
    const working = await blobId(historyText(fileOf(useEditorStore.getState())));
    await store.journalPut(
      operationRecord('o_crash', 'restore', 'pointer-moved', { repoId: store.repoId, copyId: useEvolutionStore.getState().copyId!, sessionId: '1', pointer: { kind: 'ref', ref: MAIN_REF, from: second, to: restoreCommit }, workingBefore: working, workingAfter: await blobId(firstText), target: restoreCommit }, 1),
    );
    await recoverOperations();
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id)).toEqual(['n_api']);
    expect(await store.journalList()).toEqual([]);
  });

  it('keeps both versions and asks when the diagram changed since', async () => {
    await start();
    const first = await tipOf();
    const store = historyService().store!;
    const signature = { name: 'T', email: 't@draftcanvas.invalid', timestamp: 1, timezoneOffset: 0 };
    const restoreCommit = await store.writeSnapshot({ text: await store.readSnapshot(first), parents: [first], author: signature, committer: signature, message: 'Restore\n' });
    await store.updateRef({ ref: MAIN_REF, expected: first, next: restoreCommit });
    await store.journalPut(
      operationRecord('o_ask', 'restore', 'pointer-moved', { repoId: store.repoId, copyId: useEvolutionStore.getState().copyId!, sessionId: '1', pointer: { kind: 'ref', ref: MAIN_REF, from: first, to: restoreCommit }, workingBefore: 'f'.repeat(40), workingAfter: 'e'.repeat(40), target: restoreCommit }, 1),
    );
    await recoverOperations();
    expect(useEvolutionStore.getState().unfinished).toMatchObject({ opId: 'o_ask', kind: 'restore' });
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id)).toEqual(['n_api']);
  });
});

describe('merging alternatives', { timeout: 60_000 }, () => {
  it('combines two directions into a real merge, keeping both histories', async () => {
    const { startMerge, finishMerge } = await import('../../src/store/evolution/merging');
    await start();
    await createAlternative('Event-driven');
    const altId = useEvolutionStore.getState().altId!;
    await edit((file) => addNodes(file, [createNode({ type: 'queue', x: 300, y: 0, id: 'n_q', text: 'Events' })]));
    const altTip = await tipOf(branchOf(altId));
    await switchAlternative(null);
    await edit((file) => addNodes(file, [createNode({ type: 'database', x: 0, y: 300, id: 'n_db', text: 'Ledger' })]));
    const mainTip = await tipOf();
    const started = await startMerge(altId);
    expect(started.ok).toBe(true);
    const session = useEvolutionStore.getState().merge!;
    expect(session.result.conflicts).toEqual([]);
    const finished = await finishMerge();
    expect(finished.ok).toBe(true);
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id).sort()).toEqual(['n_api', 'n_db', 'n_q']);
    const merge = await historyService().store!.readCommit(await tipOf());
    expect(merge.parents).toEqual([mainTip, altTip]);
    expect(parseMessage(merge.message).trailers.initiator).toBe('merge');
  });

  it('waits for a choice on each difference, and follows it', async () => {
    const { startMerge, finishMerge, chooseConflict } = await import('../../src/store/evolution/merging');
    await start();
    await createAlternative('Renamed');
    const altId = useEvolutionStore.getState().altId!;
    await edit((file) => updateNode(file, 'n_api', { text: 'Edge Gateway' }));
    await switchAlternative(null);
    await edit((file) => updateNode(file, 'n_api', { text: 'Public API' }));
    await startMerge(altId);
    const conflict = useEvolutionStore.getState().merge!.result.conflicts[0]!;
    expect(conflict).toMatchObject({ kind: 'both-changed', key: 'node:n_api' });
    expect((await finishMerge()).ok).toBe(false);
    await chooseConflict(conflict.id, 'theirs');
    expect((await finishMerge()).ok).toBe(true);
    expect(fileOf(useEditorStore.getState()).nodes[0]!.text).toBe('Edge Gateway');
  });

  it('fast-forwards when the other is simply ahead, without a merge revision', async () => {
    const { startMerge } = await import('../../src/store/evolution/merging');
    await start();
    await createAlternative('Ahead');
    const altId = useEvolutionStore.getState().altId!;
    await edit((file) => addNodes(file, [createNode({ type: 'queue', x: 300, y: 0, id: 'n_q', text: 'Events' })]));
    const altTip = await tipOf(branchOf(altId));
    await switchAlternative(null);
    const outcome = await startMerge(altId);
    expect(outcome.ok).toBe(true);
    expect(await tipOf()).toBe(altTip);
    expect(fileOf(useEditorStore.getState()).nodes.map((node) => node.id).sort()).toEqual(['n_api', 'n_q']);
  });
});

describe('the agent history tool', { timeout: 60_000 }, () => {
  it('reads summaries, compares and previews, and changes nothing', async () => {
    const { historyTool } = await import('../../src/store/evolution/agentTool');
    const doc = await start();
    const first = await tipOf();
    await edit((file) => addNodes(file, [createNode({ type: 'database', x: 0, y: 200, id: 'n_db', text: 'PostgreSQL' })]));
    const before = fileOf(useEditorStore.getState());
    const list = await historyTool({ diagramId: doc.metadata.id, action: 'list' });
    expect((list.revisions as unknown[]).length).toBe(2);
    const compared = await historyTool({ diagramId: doc.metadata.id, action: 'compare', revision: first, against: 'live' });
    expect(compared.summary).toBe('Add PostgreSQL');
    const preview = await historyTool({ diagramId: doc.metadata.id, action: 'preview_restore', revision: first });
    expect(preview.wouldChange).toBe('Remove PostgreSQL');
    expect(fileOf(useEditorStore.getState())).toBe(before);
  });

  it('refuses a closed diagram, and full past content unless the person allowed it', async () => {
    const { historyTool, HistoryToolError } = await import('../../src/store/evolution/agentTool');
    const doc = await start();
    const first = await tipOf();
    await expect(historyTool({ diagramId: 'd_other', action: 'summary' })).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
    await expect(historyTool({ diagramId: doc.metadata.id, action: 'read', revision: first })).rejects.toBeInstanceOf(HistoryToolError);
    localStorage.setItem('draft-canvas.history-agents-read', 'on');
    try {
      const read = await historyTool({ diagramId: doc.metadata.id, action: 'read', revision: first });
      expect(read.nodes).toBe(1);
    } finally {
      localStorage.removeItem('draft-canvas.history-agents-read');
    }
  });

  it('only suggests a milestone: nothing is named until the person accepts', async () => {
    const { historyTool } = await import('../../src/store/evolution/agentTool');
    const doc = await start();
    await historyTool({ diagramId: doc.metadata.id, action: 'suggest_milestone', name: 'Reviewed' });
    expect(useEvolutionStore.getState().milestoneSuggestion).toMatchObject({ name: 'Reviewed' });
    expect(await historyService().store!.listTags('refs/tags/milestone')).toEqual([]);
  });
});

describe('duplicating with history', { timeout: 30_000 }, () => {
  it('gives the copy a history of its own that records where it came from', async () => {
    const doc = await start();
    await edit((file) => addNodes(file, [createNode({ type: 'database', x: 0, y: 200, id: 'n_db', text: 'PostgreSQL' })]));
    const tip = await tipOf();
    const sourceRepo = historyService().store!.repoId;
    const clone = cloneDocumentAsNew(fileOf(useEditorStore.getState()), 'Ops copy');
    const from = { kind: 'library' as const, documentId: doc.metadata.id };
    const to = { kind: 'library' as const, documentId: clone.metadata.id };
    expect(await hasHistory(to)).toBe(false);
    expect(await duplicateHistory(from, to, { documentId: clone.metadata.id, title: 'Ops copy' })).toBe(true);
    await detachHistory();

    useEditorStore.getState().setDocument(clone);
    await attachHistory(to);
    const store = historyService().store!;
    expect(store.repoId).not.toBe(sourceRepo);
    expect(await store.readRef(MAIN_REF)).toBe(tip);
    expect((await store.log({ from: [tip], limit: 10 })).length).toBe(2);
    expect(await store.meta()).toMatchObject({ documentId: clone.metadata.id, title: 'Ops copy', lineage: { repoId: sourceRepo, oid: tip } });

    // The two now record separately.
    await edit((file) => updateNode(file, 'n_api', { text: 'Edge' }));
    expect(await store.readRef(MAIN_REF)).not.toBe(tip);
  });

  it('copies nothing when the original has no history', async () => {
    const from = { kind: 'library' as const, documentId: 'never-recorded' };
    expect(await duplicateHistory(from, { kind: 'library', documentId: 'other' }, { documentId: 'other', title: 'x' })).toBe(false);
  });
});
