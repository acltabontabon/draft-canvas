import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
import { historyText } from '../../src/evolution/snapshot';
import { blobId } from '../../src/evolution/hash';
import { operationRecord } from '../../src/evolution/journal';
import { branchOf, MAIN_REF } from '../../src/evolution/refs';
import { parseMessage } from '../../src/evolution/trailers';
import { attachHistory, detachHistory, historyService } from '../../src/store/evolution/bridge';
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
