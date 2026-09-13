import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
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

let posted: Array<{ message: { type: string; text?: string; saveAs?: boolean }; origin: string }>;

function Probe({ onRender }: { onRender: (state: { openId: string | null; error: string | null }) => void }) {
  const session = useDocumentSession();
  const error = useHostDocument(session);
  onRender({ openId: session.openId, error });
  return null;
}

function mount() {
  let latest = { openId: null as string | null, error: null as string | null };
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
});
