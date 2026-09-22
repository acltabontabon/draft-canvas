import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../../src/document/factory';
import { serializeDocument } from '../../src/export/project';
import type { ToHostMessage } from '../../src/host/embeddedHost';
import { createHostLink } from '../../src/desktop/channel';
import { registerDesktopHost } from '../../src/host/hostInfo';

const { useHostDocument } = await import('../../src/host/useHostDocument');
const { useDocumentSession } = await import('../../src/store/useDocumentSession');
const { useEditorStore } = await import('../../src/store/editorStore');
const { __setRepository, getRepository } = await import('../../src/storage');

let posted: ToHostMessage[];
let opened: { text: string; seq?: number }[];
let host: ReturnType<typeof createHostLink>;
let latestSession: ReturnType<typeof useDocumentSession>;
const sessionOf = () => latestSession;

function Probe({ onRender }: { onRender: (session: ReturnType<typeof useDocumentSession>) => void }) {
  const session = useDocumentSession();
  onRender(session);
  useHostDocument(session, host.channel);
  return null;
}

const mount = () => render(<Probe onRender={(session) => (latestSession = session)} />);

beforeEach(() => {
  posted = [];
  opened = [];
  host = createHostLink();
  host.link.onMessage = (message) => posted.push(message);
  host.link.onOpened = (info) => opened.push(info);
  // The desktop is a host: its documents live in memory, the way a VS Code file's do.
  registerDesktopHost({ channel: host.channel, returnHome: () => {} });
});

afterEach(() => {
  registerDesktopHost(null);
  __setRepository(null);
  vi.restoreAllMocks();
});

const messages = (type: ToHostMessage['type']) => posted.filter((message) => message.type === type);

describe('the desktop channel', () => {
  it('holds a file sent before the app was listening, and opens it once it is', async () => {
    const file = createDocument('Payments');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(file), title: 'Payments', seq: 1 });

    mount();

    await waitFor(() => expect(sessionOf().openId).toBe(file.metadata.id));
    expect(useEditorStore.getState().document.metadata.title).toBe('Payments');
  });

  it('tells the shell what it opened, as the app itself serializes it, and never says the file changed', async () => {
    mount();
    const file = createDocument('Payments');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(file), seq: 4 });

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]!.seq).toBe(4);
    expect(JSON.parse(opened[0]!.text).metadata.id).toBe(file.metadata.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages('draft-canvas:change')).toHaveLength(0);
  });

  it('sends every edit across, stamped with the load it was made on', async () => {
    mount();
    const file = createDocument('Payments');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(file), seq: 3 });
    await waitFor(() => expect(sessionOf().openId).toBe(file.metadata.id));

    act(() => useEditorStore.getState().rename('Checkout'));

    await waitFor(() => expect(messages('draft-canvas:change')).toHaveLength(1));
    const change = messages('draft-canvas:change')[0] as Extract<ToHostMessage, { type: 'draft-canvas:change' }>;
    expect(JSON.parse(change.text).metadata.title).toBe('Checkout');
    expect(change.baseSeq).toBe(3);
  });

  it('answers a flush once its pending edits are posted', async () => {
    mount();
    const file = createDocument('Payments');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(file), seq: 1 });
    await waitFor(() => expect(sessionOf().openId).toBe(file.metadata.id));

    act(() => useEditorStore.getState().rename('Checkout'));
    host.link.deliver({ type: 'draft-canvas:command', command: 'flush', id: 12 });

    await waitFor(() => expect(messages('draft-canvas:flushed')).toEqual([{ type: 'draft-canvas:flushed', id: 12 }]));
    // The edit was posted before the answer, so the shell acts on what is on screen.
    expect(posted.findIndex((message) => message.type === 'draft-canvas:change')).toBeLessThan(
      posted.findIndex((message) => message.type === 'draft-canvas:flushed'),
    );
  });

  it('closes the document when told to, and says that Home is showing', async () => {
    mount();
    const file = createDocument('Payments');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(file), seq: 1 });
    await waitFor(() => expect(sessionOf().openId).toBe(file.metadata.id));

    host.link.deliver({ type: 'draft-canvas:command', command: 'close' });

    await waitFor(() => expect(sessionOf().openId).toBeNull());
    await waitFor(() => expect(messages('draft-canvas:closed')).toHaveLength(1));
  });

  it('says that Home is showing when the app closes the document itself', async () => {
    mount();
    const file = createDocument('Payments');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(file), seq: 1 });
    await waitFor(() => expect(sessionOf().openId).toBe(file.metadata.id));

    await act(async () => sessionOf().closeDocument());

    await waitFor(() => expect(messages('draft-canvas:closed')).toHaveLength(1));
  });

  it('lets go of each file as the next one opens, so a long-running app does not hold them all', async () => {
    mount();
    const first = createDocument('One');
    const second = createDocument('Two');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(first), seq: 1 });
    await waitFor(() => expect(sessionOf().openId).toBe(first.metadata.id));

    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(second), seq: 2 });
    await waitFor(() => expect(sessionOf().openId).toBe(second.metadata.id));

    const repository = await getRepository();
    await waitFor(async () => expect(await repository.has(first.metadata.id)).toBe(false));
    expect(await repository.has(second.metadata.id)).toBe(true);
  });

  it('opens the same text again once Home has been showing', async () => {
    mount();
    const file = createDocument('Payments');
    host.link.deliver({ type: 'draft-canvas:load', text: serializeDocument(file), seq: 1 });
    await waitFor(() => expect(opened).toHaveLength(1));
    const shown = opened[0]!.text;

    await act(async () => sessionOf().closeDocument());
    await waitFor(() => expect(sessionOf().openId).toBeNull());

    // A recovered Quick Draft is exactly what was last on screen, and must still open.
    host.link.deliver({ type: 'draft-canvas:load', text: shown, seq: 2 });

    await waitFor(() => expect(sessionOf().openId).toBe(file.metadata.id));
    expect(opened).toHaveLength(2);
  });

  it('keeps a file open when the shell sends the same text again', async () => {
    mount();
    const file = createDocument('Payments');
    const text = serializeDocument(file);
    host.link.deliver({ type: 'draft-canvas:load', text, seq: 1 });
    await waitFor(() => expect(opened).toHaveLength(1));

    host.link.deliver({ type: 'draft-canvas:load', text: opened[0]!.text, seq: 2 });

    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1]!.seq).toBe(2);
    expect(sessionOf().openId).toBe(file.metadata.id);
  });
});
