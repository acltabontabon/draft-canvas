import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { copyIdOf } from '../../src/evolution/identity';
import { MAIN_REF } from '../../src/evolution/refs';
import { readHistoryText } from '../../src/evolution/snapshot';
import { parseMessage } from '../../src/evolution/trailers';
import { setTimelineOpen } from '../../src/commands/evolution';
import { __setRepository } from '../../src/storage';
import { MemoryRepository } from '../../src/storage/MemoryRepository';
import { attachHistory, detachHistory, historyCopyExists, historyService, noteExternalChange } from '../../src/store/evolution/bridge';
import { useEvolutionStore, type CompareState, type MergeSession } from '../../src/store/evolution/evolutionStore';
import { showRevision } from '../../src/store/evolution/historyView';
import { useEditorStore } from '../../src/store/editorStore';
import { useUiStore } from '../../src/store/uiStore';

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
  useUiStore.getState().setHistoryLens(false);
});

let counter = 0;
async function start(): Promise<DraftDocument> {
  counter += 1;
  const doc = addNodes(createDocument(`Bridge ${counter}`), [createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' })]);
  useEditorStore.getState().setDocument(doc);
  await attachHistory({ kind: 'library', documentId: doc.metadata.id });
  await historyService().flush();
  return doc;
}

async function until(done: () => boolean) {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).toBe(true);
}

describe('the history bridge', { timeout: 30_000 }, () => {
  it('lets go of the edit lock when history detaches, as when joining a session from a past revision', async () => {
    await start();
    const tip = (await historyService().store!.readRef(MAIN_REF))!;
    await showRevision(tip);
    expect(useUiStore.getState().historyLens).toBe(true);
    // A guest's copy never attaches: detaching is all that happens to history.
    await detachHistory();
    expect(useEvolutionStore.getState().lens).toBeNull();
    expect(useUiStore.getState().historyLens).toBe(false);
  });

  it('records the person’s own pending edits under their own label before an outside change, which is the one marked external', async () => {
    const doc = await start();
    // An edit of the person's own, saved to the file but not yet in history.
    expect(useEditorStore.getState().applyToFile('Add store', (file) => addNodes(file, [createNode({ type: 'database', x: 0, y: 200, id: 'n_mine', text: 'Orders' })]))).toBe(true);
    const outside = addNodes(doc, [createNode({ type: 'queue', x: 300, y: 0, id: 'n_outside', text: 'Events' })]);
    // The shell posts the reload and reports it at once; the editor takes it in a moment later.
    noteExternalChange();
    await new Promise((resolve) => setTimeout(resolve, 0));
    useEditorStore.getState().setDocument(outside, { keepPath: true });
    await until(() => useEvolutionStore.getState().capture.kind === 'up-to-date');

    const store = historyService().store!;
    const tip = (await store.readRef(MAIN_REF))!;
    const [last, mine] = await store.log({ from: [tip], limit: 2 });
    expect(parseMessage(last!.message).trailers.initiator).toBe('external');
    expect(readHistoryText(await store.readSnapshot(last!.oid)).document.nodes.map((node) => node.id).sort()).toEqual(['n_api', 'n_outside']);
    expect(parseMessage(mine!.message).trailers.initiator).toBe('auto');
    expect(readHistoryText(await store.readSnapshot(mine!.oid)).document.nodes.map((node) => node.id).sort()).toEqual(['n_api', 'n_mine']);
  });

  it('ends a comparison when the timeline closes, but leaves a merge to its own bar', () => {
    const compare = { mode: 'overlay', side: 'after' } as unknown as CompareState;
    useEvolutionStore.setState({ timelineOpen: true, compare });
    setTimelineOpen(false);
    expect(useEvolutionStore.getState().compare).toBeNull();

    const merge = { opId: 'op' } as unknown as MergeSession;
    useEvolutionStore.setState({ timelineOpen: true, compare, merge });
    setTimelineOpen(false);
    expect(useEvolutionStore.getState().compare).toBe(compare);
    useEvolutionStore.setState({ compare: null, merge: null });
  });

  it('takes a library diagram for gone once the library no longer holds it, and a desktop copy for there', async () => {
    const repository = new MemoryRepository();
    __setRepository(repository);
    try {
      const doc = createDocument('Kept');
      await repository.save(doc);
      const key = { kind: 'library' as const, documentId: doc.metadata.id };
      expect(await historyCopyExists(copyIdOf(key))).toBe(true);
      await repository.remove(doc.metadata.id);
      expect(await historyCopyExists(copyIdOf(key))).toBe(false);
      // Neither can be checked from the page, so neither is ever taken for gone.
      expect(await historyCopyExists(copyIdOf({ kind: 'file', path: '/work/payments.draftcanvas' }))).toBe(true);
      expect(await historyCopyExists(copyIdOf({ kind: 'draft', recoveryId: 'q_gone' }))).toBe(true);
    } finally {
      __setRepository(null);
    }
  });
});
