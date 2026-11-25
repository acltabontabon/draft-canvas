import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import type { DesktopApi } from '../../src/desktop/api';
import { DesktopError } from '../../src/desktop/api';
import { RemoteHistoryError } from '../../src/desktop/historyRemote';
import { connectRemote, disconnectRemote, fetchNow, installRemoteHistory, planPublish, publishNow, remoteOf, setPublishPolicy } from '../../src/desktop/remoteHistory';
import { MAIN_REF } from '../../src/evolution/refs';
import { attachHistory, detachHistory, historyService } from '../../src/store/evolution/bridge';
import { useEvolutionStore } from '../../src/store/evolution/evolutionStore';
import { addMilestone } from '../../src/store/evolution/historyView';
import { useEditorStore } from '../../src/store/editorStore';

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

/** Just the shell's remote commands, recording what was asked of it. */
function fakeShell() {
  const pushed: string[][] = [];
  let fail: DesktopError | null = null;
  const api = {
    historyRemoteSet: async (_repo: string, url: string) => url.replace(/\/$/, ''),
    historyRemoteRemove: async () => undefined,
    historyFetch: async () => {
      if (fail) throw fail;
      return { refs: [], branches: [{ branch: MAIN_REF, local: null, remote: null, ahead: 1, behind: 0 }] };
    },
    historyPushPreview: async (_repo: string, refs: string[]) =>
      refs.map((ref) => ({ ref, destination: ref, local: 'a'.repeat(40), remote: null, outgoing: ref.startsWith('refs/heads/') ? 1 : 0, subjects: ['Add API Gateway'], fastForward: true, upToDate: false })),
    historyPush: async (_repo: string, refs: string[]) => {
      if (fail) throw fail;
      pushed.push(refs);
      return refs.map((ref) => ({ ref, oid: 'a'.repeat(40), upToDate: false }));
    },
  } as unknown as DesktopApi;
  return { api, pushed, failWith: (error: DesktopError | null) => (fail = error) };
}

let counter = 0;
async function start() {
  counter += 1;
  const doc = addNodes(createDocument(`Remote ${counter}`), [createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' })]);
  useEditorStore.getState().setDocument(doc);
  await attachHistory({ kind: 'library', documentId: doc.metadata.id });
  await historyService().flush();
  return doc;
}

describe('publishing history', { timeout: 30_000 }, () => {
  it('keeps the remote in the history, sends nothing on connect, and asks before the first publish', async () => {
    const shell = fakeShell();
    installRemoteHistory(shell.api, () => null);
    await start();
    expect(await connectRemote('https://example.com/me/arch.git/')).toBe('https://example.com/me/arch.git');
    expect(remoteOf()).toMatchObject({ url: 'https://example.com/me/arch.git', policy: 'manual', publishAlternatives: [] });
    expect((await historyService().store!.meta()).remote?.url).toBe('https://example.com/me/arch.git');
    expect(shell.pushed).toEqual([]);

    const plan = await planPublish();
    expect(plan.first).toBe(true);
    expect(plan.refs.map((ref) => ref.ref)).toEqual([MAIN_REF]);
    await expect(publishNow()).rejects.toBeInstanceOf(RemoteHistoryError);
    expect(shell.pushed).toEqual([]);

    await publishNow(true);
    expect(shell.pushed).toEqual([[MAIN_REF]]);
    expect(remoteOf()?.confirmedDestination).toBe('https://example.com/me/arch.git');
    expect((await planPublish()).first).toBe(false);
  });

  it('publishes only milestones when that is the policy', async () => {
    const shell = fakeShell();
    installRemoteHistory(shell.api, () => null);
    await start();
    await connectRemote('https://example.com/me/arch.git');
    await setPublishPolicy('milestones');
    await expect(planPublish()).rejects.toThrow('no milestones');
    await addMilestone((await historyService().store!.readRef(MAIN_REF))!, 'Reviewed');
    const plan = await planPublish();
    expect(plan.refs).toHaveLength(1);
    expect(plan.refs[0]!.ref.startsWith('refs/tags/milestone/')).toBe(true);
  });

  it('says where it stands after a fetch, and says plainly when the remote cannot be reached', async () => {
    const shell = fakeShell();
    installRemoteHistory(shell.api, () => null);
    await start();
    await connectRemote('https://example.com/me/arch.git');
    expect((await fetchNow()).kind).toBe('not-published');
    shell.failWith(new DesktopError('Io', 'Could not resolve host', undefined, 'offline'));
    await expect(fetchNow()).rejects.toBeInstanceOf(RemoteHistoryError);
    expect(useEvolutionStore.getState().remote).toEqual({ kind: 'offline' });
    shell.failWith(null);

    await disconnectRemote();
    expect(remoteOf()).toBeNull();
    expect(useEvolutionStore.getState().remote).toEqual({ kind: 'none' });
  });
});
