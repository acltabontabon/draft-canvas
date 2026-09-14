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
});
