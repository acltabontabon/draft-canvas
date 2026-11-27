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
