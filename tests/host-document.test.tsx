import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeClipboard, encodeClipboard } from '../src/document/clipboardCodec';
import { createDocument, createNode } from '../src/document/factory';
import { serializeDocument } from '../src/export/project';

// Framed by VS Code: jsdom's window is its own parent, which stands in for the host's webview.
vi.mock('../src/host/embeddedHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/host/embeddedHost')>()),
  embeddedHost: 'vscode',
}));

const { useHostDocument } = await import('../src/host/useHostDocument');
const { useDocumentSession } = await import('../src/store/useDocumentSession');
const { useEditorStore } = await import('../src/store/editorStore');
const { __setRepository } = await import('../src/storage');

const HOST_ORIGIN = 'vscode-webview://abc123';

let posted: Array<{ message: { type: string; text?: string; saveAs?: boolean; baseSeq?: number }; origin: string }>;

type ProbeState = { openId: string | null; error: string | null; invalidWhileOpen: boolean };

function Probe({ onRender }: { onRender: (state: ProbeState) => void }) {
  const session = useDocumentSession();
  const host = useHostDocument(session);
  onRender({ openId: session.openId, ...host });
  return null;
}

function mount() {
  let latest: ProbeState = { openId: null, error: null, invalidWhileOpen: false };
  render(<Probe onRender={(state) => (latest = state)} />);
  return () => latest;
}

function fromHost(data: unknown, origin = HOST_ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: window }));
  });
}

const messages = (type: string) => posted.filter((entry) => entry.message.type === type);

beforeEach(() => {
  posted = [];
  vi.spyOn(window, 'postMessage').mockImplementation(((message: never, origin: string) => {
    posted.push({ message, origin });
  }) as typeof window.postMessage);
});

afterEach(() => {
  vi.restoreAllMocks();
  __setRepository(null);
});

describe('embedded in a host', () => {
  it('says it is ready, then opens the file without dirtying it', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));

    const file = createDocument('Payments');
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(file) });

    await waitFor(() => expect(state().openId).toBe(file.metadata.id));
    expect(useEditorStore.getState().document.metadata.title).toBe('Payments');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages('draft-canvas:change')).toHaveLength(0);
  });

  it('says what it repaired when opening a damaged file, instead of repairing it silently', async () => {
    const { useUiStore } = await import('../src/store/uiStore');
    useUiStore.setState({ toasts: [] });
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    const file = createDocument('Payments');
    const damaged = JSON.parse(serializeDocument(file));
    damaged.edges = [{ id: 'e1', source: 'missing-a', target: 'missing-b' }];
    fromHost({ type: 'draft-canvas:load', text: JSON.stringify(damaged) });

    await waitFor(() => expect(state().openId).toBe(file.metadata.id));
    const toasts = useUiStore.getState().toasts.map((toast) => toast.message);
    expect(toasts).toEqual([expect.stringContaining('pointing at nodes that do not exist')]);
  });

  it('opens a clean file without any repair notice', async () => {
    const { useUiStore } = await import('../src/store/uiStore');
    useUiStore.setState({ toasts: [] });
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    const file = createDocument('Payments');
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(file) });

    await waitFor(() => expect(state().openId).toBe(file.metadata.id));
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('sends every edit back as the whole file, to the host only', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    const file = createDocument('Payments');
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(file) });
    await waitFor(() => expect(state().openId).toBe(file.metadata.id));

    act(() => useEditorStore.getState().rename('Checkout'));

    await waitFor(() => expect(messages('draft-canvas:change')).toHaveLength(1));
    const change = messages('draft-canvas:change')[0]!;
    expect(change.origin).toBe(HOST_ORIGIN);
    expect(JSON.parse(change.message.text!).metadata.title).toBe('Checkout');
  });

  it('ends on the newest of two files sent back to back, without writing either back', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    const saved = createDocument('Saved');
    const restored = { ...saved, metadata: { ...saved.metadata, title: 'Unsaved edits' } };

    fromHost({ type: 'draft-canvas:load', text: serializeDocument(saved) });
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(restored) });

    await waitFor(() => expect(useEditorStore.getState().document.metadata.title).toBe('Unsaved edits'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useEditorStore.getState().document.metadata.title).toBe('Unsaved edits');
    expect(state().openId).toBe(saved.metadata.id);
    expect(messages('draft-canvas:change')).toHaveLength(0);
  });

  it('gives a new, empty file a document named after it', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));

    fromHost({ type: 'draft-canvas:load', text: '', title: 'Untitled-1' });

    await waitFor(() => expect(messages('draft-canvas:change')).toHaveLength(1));
    expect(state().openId).not.toBeNull();
    expect(JSON.parse(messages('draft-canvas:change')[0]!.message.text!).metadata.title).toBe('Untitled-1');
  });

  it('opens nothing and writes nothing for a file that is not a diagram', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));

    fromHost({ type: 'draft-canvas:load', text: '{ "not": "a diagram" }' });

    await waitFor(() => expect(state().error).not.toBeNull());
    expect(state().openId).toBeNull();
    expect(messages('draft-canvas:change')).toHaveLength(0);
  });

  it('ignores a page that is not the host', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));

    fromHost({ type: 'draft-canvas:load', text: serializeDocument(createDocument()) }, 'https://example.com');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state().openId).toBeNull();
  });

  it('forwards ⌘S, which the host never sees from inside the frame', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(createDocument()) });
    await waitFor(() => expect(state().openId).not.toBeNull());

    const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true });
    act(() => void window.dispatchEvent(event));

    await waitFor(() => expect(messages('draft-canvas:save')).toHaveLength(1));
    expect(event.defaultPrevented).toBe(true);
    expect(messages('draft-canvas:save')[0]!.message.saveAs).toBe(false);
  });

  it('keeps the last valid diagram when the file stops being one, and writes nothing until it is again', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    const file = createDocument('Payments');
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(file), seq: 1 });
    await waitFor(() => expect(state().openId).toBe(file.metadata.id));

    fromHost({ type: 'draft-canvas:load', text: '{ "half typed', seq: 2 });
    await waitFor(() => expect(state().invalidWhileOpen).toBe(true));
    expect(useEditorStore.getState().document.metadata.title).toBe('Payments');

    act(() => useEditorStore.getState().rename('Not written'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages('draft-canvas:change')).toHaveLength(0);

    const fixed = { ...file, metadata: { ...file.metadata, title: 'Fixed' } };
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(fixed), seq: 3 });
    await waitFor(() => expect(state().invalidWhileOpen).toBe(false));
    expect(useEditorStore.getState().document.metadata.title).toBe('Fixed');

    act(() => useEditorStore.getState().rename('Checkout'));
    await waitFor(() => expect(messages('draft-canvas:change')).toHaveLength(1));
    // Made on top of the third load, and says so.
    expect(messages('draft-canvas:change')[0]!.message.baseSeq).toBe(3);
  });

  it('⌘S while a field is still being typed in commits that text before asking the host to save', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(createDocument('Before')) });
    await waitFor(() => expect(state().openId).not.toBeNull());

    const input = document.createElement('input');
    input.addEventListener('blur', () => useEditorStore.getState().rename('Typed'));
    document.body.append(input);
    input.focus();

    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true })));
    await waitFor(() => expect(messages('draft-canvas:save')).toHaveLength(1));
    input.remove();

    const types = posted.map((entry) => entry.message.type);
    expect(types.lastIndexOf('draft-canvas:change')).toBeLessThan(types.indexOf('draft-canvas:save'));
    expect(JSON.parse(messages('draft-canvas:change').at(-1)!.message.text!).metadata.title).toBe('Typed');
  });

  it("hands links to other sites to the host, which the frame can't open", async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(createDocument()) });
    await waitFor(() => expect(state().openId).not.toBeNull());

    const click = (href: string) => {
      const link = Object.assign(document.createElement('a'), { href, target: '_blank' });
      link.append(document.createElement('span'));
      document.body.append(link);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.firstElementChild!.dispatchEvent(event);
      link.remove();
      return event;
    };

    expect(click('https://github.com/acltabontabon/draft-canvas').defaultPrevented).toBe(true);
    expect(click('mailto:someone@example.com').defaultPrevented).toBe(true);
    expect(click('#section').defaultPrevented).toBe(false);
    // This site's own pages too — the frame can't open any new window.
    expect(click(`${window.location.origin}/`).defaultPrevented).toBe(true);

    const opened = messages('draft-canvas:open-external');
    expect(opened.map((entry) => (entry.message as { url?: string }).url)).toEqual([
      'https://github.com/acltabontabon/draft-canvas',
      'mailto:someone@example.com',
      `${window.location.origin}/`,
    ]);
    expect(opened.every((entry) => entry.origin === HOST_ORIGIN)).toBe(true);
  });

  describe('clipboard through the host', () => {
    async function openWith(load: Record<string, unknown>) {
      const state = mount();
      await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
      const file = createDocument('Payments');
      fromHost({ type: 'draft-canvas:load', text: serializeDocument(file), ...load });
      await waitFor(() => expect(state().openId).toBe(file.metadata.id));
    }

    function selectOneNode() {
      const node = createNode({ type: 'service', x: 0, y: 0, text: 'Orders' });
      act(() => {
        useEditorStore.getState().addNodesWithEdges([node], [], 'Add');
        useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });
      });
    }

    it('copy and cut go to a host that offers its clipboard', async () => {
      await openWith({ clipboard: true });
      selectOneNode();

      act(() => void useEditorStore.getState().copySelection());
      act(() => void useEditorStore.getState().cutSelection());

      const writes = messages('draft-canvas:clipboard-write');
      expect(writes).toHaveLength(2);
      expect(writes.every((entry) => entry.origin === HOST_ORIGIN)).toBe(true);
      expect(decodeClipboard(writes[0]!.message.text!)?.nodes[0]?.text).toBe('Orders');
    });

    it('a paste reads the clipboard from the host, matching its answer by id', async () => {
      await openWith({ clipboard: true });
      const copied = encodeClipboard({ nodes: [createNode({ type: 'note', x: 0, y: 0, text: 'From B' })], edges: [] });

      let synced: Promise<boolean> = Promise.resolve(false);
      act(() => {
        synced = useEditorStore.getState().syncClipboardFromSystem();
      });
      const read = messages('draft-canvas:clipboard-read')[0]!.message as unknown as { id: number };
      fromHost({ type: 'draft-canvas:clipboard', id: read.id + 1, text: 'another request' });
      fromHost({ type: 'draft-canvas:clipboard', id: read.id, text: copied });

      await expect(synced).resolves.toBe(true);
      expect(useEditorStore.getState().clipboard?.nodes[0]?.text).toBe('From B');
    });

    it('an older host, which never offered its clipboard, gets no clipboard messages', async () => {
      await openWith({});
      selectOneNode();
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockRejectedValue(new Error('denied')) } });

      act(() => void useEditorStore.getState().copySelection());
      await expect(useEditorStore.getState().syncClipboardFromSystem()).resolves.toBe(false);

      expect(messages('draft-canvas:clipboard-write')).toHaveLength(0);
      expect(messages('draft-canvas:clipboard-read')).toHaveLength(0);
      // Same-tab paste still has the in-memory copy.
      expect(useEditorStore.getState().clipboard?.nodes[0]?.text).toBe('Orders');
      vi.unstubAllGlobals();
    });
  });
});
