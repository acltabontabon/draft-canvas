import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import { MAIN_REF } from '../../src/evolution/refs';
import { attachHistory, detachHistory, hasHistory, historyService } from '../../src/store/evolution/bridge';
import { useEditorStore } from '../../src/store/editorStore';
import { HistorySettings } from '../../src/ui/settings/HistorySettings';

/** Web Locks for jsdom: one process, held until released. */
beforeAll(() => {
  const held = new Map<string, Promise<void>>();
  const locks = {
    async request(name: string, options: { ifAvailable?: boolean }, run: (lock: unknown) => Promise<void> | void) {
      if (options.ifAvailable && held.has(name)) return run(null);
      const before = held.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      const queued = before.then(() => mine);
      held.set(name, queued);
      await before;
      try {
        return await run({ name });
      } finally {
        release();
        if (held.get(name) === queued) held.delete(name);
      }
    },
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
});

afterEach(async () => {
  await detachHistory();
});

describe('Settings → History', { timeout: 30_000 }, () => {
  it('says a history another diagram continues is kept for it, and removes it from this diagram only', async () => {
    const doc = addNodes(createDocument('Shared in settings'), [createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' })]);
    useEditorStore.getState().setDocument(doc);
    const here = { kind: 'library' as const, documentId: doc.metadata.id };
    const other = { kind: 'file' as const, path: '/work/payments-v2.draftcanvas' };
    await attachHistory(here);
    await historyService().flush();
    const store = historyService().store!;
    // A Save As copy that chose "Continue its history".
    await historyService().putBindingFor({ ...historyService().binding!, copyId: 'file_/work/payments-v2.draftcanvas' });
    render(<HistorySettings />);
    await screen.findByRole('button', { name: 'Delete the shared history…' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove this diagram’s history…' }));
    expect(screen.getByText(/Another diagram on this device continues this history, so it is kept for that diagram and nothing is deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this diagram' }));
    await screen.findByText('This diagram no longer uses that history. It is still on this device for the other diagram.');
    expect(await hasHistory(here)).toBe(false);
    expect(await hasHistory(other)).toBe(true);
    expect(await store.readRef(MAIN_REF)).toBeTruthy();
  });
});
