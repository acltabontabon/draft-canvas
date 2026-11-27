/**
 * The desktop controller and the app together: the real `DesktopController` driving the real document
 * session and `useHostDocument` over the real in-page link, with only the shell faked (`harness.ts`).
 * For what only shows in their timing: React's commits, blurs, and loads crossing in flight.
 */
import { act, render, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostLink } from '../../src/desktop/channel';
import { DesktopController, type DesktopUi } from '../../src/desktop/controller';
import { DesktopStore } from '../../src/desktop/store';
import { __resetAgentWrites, rememberPendingWrite } from '../../src/desktop/agentWrites';
import { registerDesktopHost } from '../../src/host/hostInfo';
import { useHostDocument } from '../../src/host/useHostDocument';
import { useDocumentSession } from '../../src/store/useDocumentSession';
import { useEditorStore } from '../../src/store/editorStore';
import { __setRepository } from '../../src/storage';
import { MemoryRepository } from '../../src/storage/MemoryRepository';
import { createHarness, documentText } from './harness';

afterEach(() => {
  registerDesktopHost(null);
  __setRepository(null);
  __resetAgentWrites();
  vi.restoreAllMocks();
});

/** A started controller on the harness's shell, and the app it drives, mounted. */
async function connect({ duringCommit }: { duringCommit?: (openId: string | null) => void } = {}) {
  const h = createHarness();
  const host = createHostLink();
  const notices: string[] = [];
  const ui: DesktopUi = { openAbout() {}, openShortcuts() {}, openSettings() {}, notify: (message) => void notices.push(message), openRename() {}, openMove() {}, editCommand() {}, canvasCommand() {} };
  const store = new DesktopStore();
  const controller = new DesktopController({ api: h.api, link: host.link, store, ui });
  registerDesktopHost({ channel: host.channel, returnHome: () => void controller.returnHome() });
  await controller.start();
  let session: ReturnType<typeof useDocumentSession> | null = null;
  function App() {
    const current = useDocumentSession();
    session = current;
    useHostDocument(current, host.channel);
    // After the app's own effects in the same commit, as the editor's unmounting is.
    useLayoutEffect(() => duringCommit?.(current.openId), [current.openId]);
    return null;
  }
  render(<App />);
  const open = async (name: string) => {
    const handle = h.addFile(name);
    await controller.openHandle(handle);
    await waitFor(() => expect(store.getSnapshot().doc).toMatchObject({ kind: 'file', name, dirty: false }));
    return handle;
  };
  return { h, controller, store, notices, session: () => session!, open };
}

const title = () => useEditorStore.getState().document.metadata.title;

it('keeps the Quick Draft ⌘N opened while Back’s close of the last file was still being drawn', async () => {
  let slowClose = false;
  let h: ReturnType<typeof createHarness> | null = null;
  const app = await connect({
    duringCommit: (openId) => {
      if (!slowClose || openId !== null) return;
      slowClose = false;
      // ⌘N arrives from the shell while the commit that takes a big canvas away is still running.
      setImmediate(() => h!.hostEvent({ type: 'new-quick-draft' }));
      const until = performance.now() + 10;
      while (performance.now() < until) {
        // The unmount of a large diagram.
      }
    },
  });
  h = app.h;
  await app.open('payments');

  slowClose = true;
  await app.controller.returnHome();
  await waitFor(() => expect(app.session().openId !== null && title() === 'Quick Draft').toBe(true));
  expect(app.store.getSnapshot().doc).toEqual({ kind: 'quick', dirty: false });

  // The draft is the controller's: its edits are heard, and quitting keeps them.
  act(() => useEditorStore.getState().rename('My architecture'));
  await waitFor(() => expect(app.store.getSnapshot().doc).toEqual({ kind: 'quick', dirty: true }));
  app.h.hostEvent({ type: 'quit-requested' });
  await waitFor(() => expect(app.h.api.quitAck).toHaveBeenLastCalledWith('ready'));
  expect([...app.h.recovery.values()].map((held) => held.entry.title)).toEqual(['My architecture']);
});

it.each([
  ['read', 0],
  ['read', 5],
  ['read', 10],
  ['remove', 0],
  ['remove', 5],
  ['remove', 10],
] as const)('ends on Home on both sides when Back comes after ⌘N, while storage is slow to %s (%i ms)', async (step, gap) => {
  // Storage takes a moment, as it does on a real machine: to read the draft back, or to forget the
  // file it replaces once the draft is on screen.
  const repository = new MemoryRepository();
  const load = repository.load.bind(repository);
  const remove = repository.remove.bind(repository);
  let slow = false;
  const pause = () => (slow ? new Promise((resolve) => setTimeout(resolve, 30)) : Promise.resolve());
  if (step === 'read') {
    repository.load = async (id: string) => {
      await pause();
      return load(id);
    };
  } else {
    repository.remove = async (id: string) => {
      await pause();
      return remove(id);
    };
  }
  __setRepository(repository);
  const app = await connect();
  await app.open('payments');
  await waitFor(() => expect(app.session().openId).not.toBeNull());

  slow = true;
  void app.controller.newQuickDraft();
  await new Promise((resolve) => setTimeout(resolve, gap));
  await app.controller.returnHome();

  // Back's close took the screen from the draft still being read. Said only about the file shown
  // before it, the close went unheard, and the shell held a Quick Draft open over Home.
  await waitFor(() => expect(app.store.getSnapshot().doc).toEqual({ kind: 'none' }));
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(app.session().openId).toBeNull();
  expect(app.store.getSnapshot().doc).toEqual({ kind: 'none' });
});

it('shows the file itself, and says why, when its recovered changes can’t be read', async () => {
  const app = await connect();
  await app.open('payments');
  const ledger = app.h.addFile('ledger');
  // Kept by a newer version, before a downgrade.
  app.h.recovery.set('f_old', {
    text: JSON.stringify({ ...(JSON.parse(documentText('ledger')) as object), version: 99 }),
    entry: { id: 'f_old', title: 'ledger', updatedAt: Date.now() - 60_000, bytes: 80, origin: { kind: 'file', name: 'ledger', displayPath: '~/work/ledger.draftcanvas', handle: ledger, baseStamp: 'v1:1' } },
  });
  app.h.answer(0);

  await app.controller.openHandle(ledger);

  expect(title()).toBe('ledger');
  expect(app.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'ledger', dirty: false });
  expect(app.h.errors.map((error) => error.title)).toEqual(['Couldn’t recover the unsaved changes to ledger.draftcanvas']);
  expect(app.h.recovery.has('f_old')).toBe(true);
});

it('leaves the field being typed in alone when an agent asks to show a diagram it changed', async () => {
  const app = await connect();
  await app.open('payments');
  // The person is typing the diagram's title: like every inline field, it commits when it lets go.
  const field = document.createElement('input');
  field.addEventListener('blur', () => useEditorStore.getState().rename(field.value));
  document.body.append(field);
  field.focus();
  field.value = 'Payments ledg';
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
  try {
    // An agent changed another, closed diagram and asked for it to be shown once written.
    const other = app.h.addFile('ledger');
    rememberPendingWrite(41, { title: 'ledger', before: documentText('ledger'), after: documentText('ledger'), activate: true });
    app.h.hostEvent({ type: 'agent-file-written', id: 41, handle: other, displayPath: '~/work/ledger.draftcanvas', stamp: 'v1:1', created: false });

    // Not opened over the typing: the notice offers it, and the field keeps its focus and its words.
    await waitFor(() => expect(app.notices).toContain('An AI agent updated “ledger”.'));
    expect(document.activeElement).toBe(field);
    expect(title()).toBe('payments');
    expect(app.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'payments', dirty: false });
  } finally {
    field.remove();
  }
});

it('shows a diagram an agent changed when a field only holds focus, nobody typing in it', async () => {
  const app = await connect();
  await app.open('payments');
  // Nodi's composer, empty, keeping focus after Send, with the last key long ago.
  const composer = document.createElement('input');
  document.body.append(composer);
  composer.focus();
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_000);
  try {
    const other = app.h.addFile('ledger');
    rememberPendingWrite(41, { title: 'ledger', before: documentText('ledger'), after: documentText('ledger'), activate: true });
    app.h.hostEvent({ type: 'agent-file-written', id: 41, handle: other, displayPath: '~/work/ledger.draftcanvas', stamp: 'v1:1', created: false });

    // Focus alone is nobody typing, as for an agent's change (`busyReason`): the diagram is shown.
    await waitFor(() => expect(app.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'ledger' }));
    await waitFor(() => expect(title()).toBe('ledger'));
  } finally {
    vi.useRealTimers();
    composer.remove();
  }
});
