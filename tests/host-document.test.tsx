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

  /**
   * In VS Code the file *is* the document, so an edit made inside a shape has to travel back as
   * the whole file — and the reload the host sends on every outside change must leave the user
   * standing in the room they were in, not throw them back out to the top of the diagram.
   */
  it('sends back what was drawn inside a shape, and stays in that room when the file reloads', async () => {
    const state = mount();
    await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
    const platform = createNode({ type: 'service', x: 0, y: 0, text: 'Lending Platform' });
    const file = { ...createDocument('Lending'), nodes: [platform] };
    fromHost({ type: 'draft-canvas:load', text: serializeDocument(file) });
    await waitFor(() => expect(state().openId).toBe(file.metadata.id));

    act(() => {
      useEditorStore.getState().enterInside(platform.id);
      useEditorStore.getState().addNode({ type: 'service', x: 20, y: 20, text: 'Lending API' });
    });

    await waitFor(() => expect(messages('draft-canvas:change')).toHaveLength(1));
    const sent = JSON.parse(messages('draft-canvas:change')[0]!.message.text!);
    expect(sent.nodes[0].inside.nodes[0].text).toBe('Lending API');

    // The host echoes the saved file back; the editor is still inside Lending Platform.
    fromHost({ type: 'draft-canvas:load', text: JSON.stringify({ ...sent, metadata: { ...sent.metadata, title: 'Lending v2' } }) });
    await waitFor(() => expect(useEditorStore.getState().document.metadata.title).toBe('Lending v2'));
    expect(useEditorStore.getState().path).toEqual([platform.id]);
    expect(useEditorStore.getState().document.nodes[0]?.text).toBe('Lending API');
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
  describe('text editing and VS Code shortcuts through the host', () => {
    let execCommand: ReturnType<typeof vi.fn>;
    let field: HTMLTextAreaElement;

    async function openWith(load: Record<string, unknown>) {
      const state = mount();
      await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
      const file = createDocument('Payments');
      fromHost({ type: 'draft-canvas:load', text: serializeDocument(file), ...load });
      await waitFor(() => expect(state().openId).toBe(file.metadata.id));
    }

    /** A key pressed in `target`, as the frame would see it. */
    function press(target: EventTarget, key: string, modifiers: KeyboardEventInit = { metaKey: true }) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
      act(() => void target.dispatchEvent(event));
      return event;
    }

    beforeEach(() => {
      execCommand = vi.fn(() => true);
      Object.assign(document, { execCommand });
      field = document.createElement('textarea');
      field.value = 'Order service';
      document.body.append(field);
      field.focus();
    });

    afterEach(() => {
      field.remove();
      Reflect.deleteProperty(document, 'execCommand');
    });

    const TEXT = { clipboard: true, textEditing: true };

    it('⌘A selects everything in the field', async () => {
      await openWith(TEXT);
      field.setSelectionRange(0, 0);
      expect(press(field, 'a').defaultPrevented).toBe(true);
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Order service'.length]);
    });

    it('⌘C sends the selected text to the host as plain text, and ⌘X also removes it', async () => {
      await openWith(TEXT);
      field.setSelectionRange(0, 5);

      expect(press(field, 'c').defaultPrevented).toBe(true);
      expect(press(field, 'x').defaultPrevented).toBe(true);

      const writes = messages('draft-canvas:clipboard-write').map((entry) => entry.message);
      expect(writes).toEqual([
        { type: 'draft-canvas:clipboard-write', text: 'Order', plain: true },
        { type: 'draft-canvas:clipboard-write', text: 'Order', plain: true },
      ]);
      expect(execCommand.mock.calls).toEqual([['delete']]);
    });

    it('a ⌘C with nothing selected writes nothing', async () => {
      await openWith(TEXT);
      field.setSelectionRange(3, 3);
      press(field, 'c');
      expect(messages('draft-canvas:clipboard-write')).toHaveLength(0);
    });

    it('⌘V inserts what the host answers a plain read with', async () => {
      await openWith(TEXT);
      expect(press(field, 'v').defaultPrevented).toBe(true);

      const read = messages('draft-canvas:clipboard-read')[0]!.message as unknown as { id: number; plain?: boolean };
      expect(read.plain).toBe(true);
      fromHost({ type: 'draft-canvas:clipboard', id: read.id, text: 'pasted words' });

      await waitFor(() => expect(execCommand).toHaveBeenCalledWith('insertText', false, 'pasted words'));
    });

    it('⌘Z and ⌘⇧Z undo and redo inside the field', async () => {
      await openWith(TEXT);
      press(field, 'z');
      press(field, 'z', { metaKey: true, shiftKey: true });
      expect(execCommand.mock.calls).toEqual([['undo'], ['redo']]);
    });

    it('a password field is never copied from', async () => {
      await openWith(TEXT);
      const secret = Object.assign(document.createElement('input'), { type: 'password', value: 'hunter2' });
      document.body.append(secret);
      secret.focus();
      secret.select();
      press(secret, 'c');
      secret.remove();
      expect(messages('draft-canvas:clipboard-write')).toHaveLength(0);
    });

    it('a host that never offered text editing leaves the keys alone', async () => {
      await openWith({ clipboard: true });
      field.select();
      for (const key of ['a', 'c', 'x', 'v', 'z']) expect(press(field, key).defaultPrevented).toBe(false);
      expect(messages('draft-canvas:clipboard-write')).toHaveLength(0);
      expect(messages('draft-canvas:clipboard-read')).toHaveLength(0);
      expect(execCommand).not.toHaveBeenCalled();
    });

    it("posts a chord the host listed and the app didn't use, and nothing else", async () => {
      await openWith({ keys: ['cmd+p', 'cmd+w', 'cmd+k'] });

      press(window, 'p');
      await waitFor(() => expect(messages('draft-canvas:key')).toHaveLength(1));
      expect(messages('draft-canvas:key')[0]!.message).toEqual({ type: 'draft-canvas:key', chord: 'cmd+p' });
      expect(messages('draft-canvas:key')[0]!.origin).toBe(HOST_ORIGIN);

      // Not listed, or alt held, or an auto-repeat: never sent.
      press(window, 'r');
      press(window, 'w', { metaKey: true, altKey: true });
      press(window, 'p', { metaKey: true, repeat: true });
      // Listed, but the app took it (its own ⌘K): the host doesn't also get it.
      const takeIt = (event: KeyboardEvent) => event.preventDefault();
      window.addEventListener('keydown', takeIt);
      press(window, 'k');
      window.removeEventListener('keydown', takeIt);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(messages('draft-canvas:key')).toHaveLength(1);
    });

    it('lets go of a field before ⌘W, so the tab closing keeps what was just typed', async () => {
      await openWith({ keys: ['cmd+w'] });
      field.addEventListener('blur', () => useEditorStore.getState().rename('Typed'));

      press(field, 'w');
      await waitFor(() => expect(messages('draft-canvas:key')).toHaveLength(1));

      const types = posted.map((entry) => entry.message.type);
      expect(types.lastIndexOf('draft-canvas:change')).toBeLessThan(types.indexOf('draft-canvas:key'));
      expect(JSON.parse(messages('draft-canvas:change').at(-1)!.message.text!).metadata.title).toBe('Typed');
    });

    it('a host that listed no keys is never sent one', async () => {
      await openWith({ clipboard: true });
      press(window, 'p');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(messages('draft-canvas:key')).toHaveLength(0);
    });
  });
  describe('the background image through the host', () => {
    const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const PNG_BASE64 = btoa(String.fromCharCode(...PNG));

    beforeEach(() => {
      // jsdom decodes no images; a bitmap with the size the canvas needs is all the app reads from one.
      vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 360, close: vi.fn() })));
    });
    afterEach(() => void vi.unstubAllGlobals());

    const withBackground = (imageId: string) => {
      const file = createDocument('Payments');
      file.settings.background = { ...file.settings.background, enabled: true, imageId };
      return file;
    };
    const repository = async () => (await import('../src/storage')).getRepository();
    const readsOf = () => messages('draft-canvas:background-read').map((entry) => entry.message as unknown as { id: number });

    async function openFile(file: ReturnType<typeof createDocument>, load: Record<string, unknown>) {
      const state = mount();
      await waitFor(() => expect(messages('draft-canvas:ready')).toHaveLength(1));
      fromHost({ type: 'draft-canvas:load', text: serializeDocument(file), ...load });
      return state;
    }

    it('asks the host for the image a file turns on, and has it stored before the canvas opens', async () => {
      const file = withBackground('bg-1');
      const state = await openFile(file, { background: true });

      await waitFor(() => expect(readsOf()).toHaveLength(1));
      // The canvas isn't shown until the host has answered.
      expect(state().openId).toBeNull();
      fromHost({ type: 'draft-canvas:background', id: readsOf()[0]!.id, mime: 'image/png', data: PNG_BASE64 });

      await waitFor(() => expect(state().openId).toBe(file.metadata.id));
      const stored = await (await repository()).loadBackgroundImage(file.metadata.id, 'bg-1');
      expect(stored).toMatchObject({ width: 640, height: 360 });
      expect(stored!.blob.type).toBe('image/png');
      expect(stored!.blob.size).toBe(PNG.length);
    });

    it('opens the file all the same when the host has no image, or an unreadable one', async () => {
      const file = withBackground('bg-2');
      const state = await openFile(file, { background: true });
      await waitFor(() => expect(readsOf()).toHaveLength(1));
      fromHost({ type: 'draft-canvas:background', id: readsOf()[0]!.id });

      await waitFor(() => expect(state().openId).toBe(file.metadata.id));
      expect(await (await repository()).loadBackgroundImage(file.metadata.id, 'bg-2')).toBeNull();
      expect(state().error).toBeNull();
    });

    it('does not ask for an image the file has switched off', async () => {
      const file = createDocument('Payments');
      const state = await openFile(file, { background: true });
      await waitFor(() => expect(state().openId).toBe(file.metadata.id));
      expect(readsOf()).toHaveLength(0);
    });

    it("reports the image when one is chosen, again when it's replaced, and when it's removed", async () => {
      const file = createDocument('Payments');
      const state = await openFile(file, { background: true });
      await waitFor(() => expect(state().openId).toBe(file.metadata.id));
      const repo = await repository();
      const store = useEditorStore.getState();

      await repo.saveBackgroundImage(file.metadata.id, new Blob([PNG], { type: 'image/png' }), { width: 640, height: 360 }, 'bg-a');
      act(() => store.updateSettings({ background: { ...store.document.settings.background, enabled: true, imageId: 'bg-a' } }));
      await waitFor(() => expect(messages('draft-canvas:background-write')).toHaveLength(1));
      expect(messages('draft-canvas:background-write')[0]!.message).toEqual({
        type: 'draft-canvas:background-write',
        mime: 'image/png',
        data: PNG_BASE64,
      });
      expect(messages('draft-canvas:background-write')[0]!.origin).toBe(HOST_ORIGIN);

      // How it is drawn is the file's business, not the host's.
      act(() => useEditorStore.getState().updateSettings({ background: { ...useEditorStore.getState().document.settings.background, dim: 0.9 } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(messages('draft-canvas:background-write')).toHaveLength(1);
      expect(messages('draft-canvas:background-remove')).toHaveLength(0);

      act(() => useEditorStore.getState().updateSettings({ background: { ...useEditorStore.getState().document.settings.background, enabled: false } }));
      await waitFor(() => expect(messages('draft-canvas:background-remove')).toHaveLength(1));
    });

    it('a host that never offered to keep the image is neither asked nor told anything about it', async () => {
      const file = withBackground('bg-3');
      const state = await openFile(file, { clipboard: true });
      await waitFor(() => expect(state().openId).toBe(file.metadata.id));
      const repo = await repository();
      await repo.saveBackgroundImage(file.metadata.id, new Blob([PNG], { type: 'image/png' }), { width: 640, height: 360 }, 'bg-b');
      act(() => useEditorStore.getState().updateSettings({ background: { ...useEditorStore.getState().document.settings.background, imageId: 'bg-b' } }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(messages('draft-canvas:background-read')).toHaveLength(0);
      expect(messages('draft-canvas:background-write')).toHaveLength(0);
      expect(messages('draft-canvas:background-remove')).toHaveLength(0);
    });
  });
});
