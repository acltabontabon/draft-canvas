import { useEffect, useState } from 'react';
import { createDocument } from '../document/factory';
import { deserializeDocument, serializeDocument } from '../export/project';
import type { DocumentSession } from '../store/useDocumentSession';
import { embeddedHost, HOST_PROTOCOL, isHostOrigin, type LoadMessage, type ToHostMessage } from './embeddedHost';

/**
 * Connects the open document to the host's file when the app is embedded (see `embeddedHost`).
 *
 * The host sends the file's text; every committed edit goes straight back as the whole serialized
 * document. There's no debounce: the host can remove the frame at any moment (closing its tab never
 * blurs the frame first), so anything not already posted would be lost. ⌘S is forwarded because a
 * key pressed inside a cross-origin frame never reaches the host's own shortcuts.
 *
 * Returns the reason a file couldn't be opened, if it couldn't.
 */
export function useHostDocument(session: DocumentSession): string | null {
  const [error, setError] = useState<string | null>(null);
  const { ready, repository, openDocument } = session;

  useEffect(() => {
    if (!embeddedHost || !ready || !repository) return;

    let hostOrigin: string | null = null;
    // The text the host holds right now, so reopening or echoing it back never dirties the file.
    let hostText: string | null = null;
    let pending = 0;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    // Loads run one at a time, and only the newest waiting one runs: VS Code can send the file twice
    // in quick succession (on restore, the saved text and then the unsaved edits it kept), and an
    // older load finishing last would show — and then write back — stale contents.
    let queued: LoadMessage | null = null;
    let loading = false;
    let loads = Promise.resolve();

    const post = (message: ToHostMessage) => {
      if (hostOrigin) window.parent.postMessage(message, hostOrigin);
    };

    const postChange = async () => {
      pending = 0;
      const { useEditorStore, documentWithLiveViewport } = await import('../store/editorStore');
      const text = serializeDocument(documentWithLiveViewport(useEditorStore.getState()));
      if (text === hostText) return;
      hostText = text;
      post({ type: 'draft-canvas:change', text });
    };

    const open = async ({ text, title }: LoadMessage) => {
      const blank = text.trim() === '';
      const parsed = blank ? null : deserializeDocument(text);
      if (parsed && !parsed.ok) {
        setError(parsed.error);
        return;
      }
      const document = parsed ? parsed.document : createDocument(title || undefined);
      setError(null);
      const { useEditorStore } = await import('../store/editorStore');
      unsubscribe ??= useEditorStore.subscribe((state, previous) => {
        // Revisions only: panning alone moves the viewport, and a file shouldn't turn dirty for that.
        // Nor does opening a document count as an edit of it.
        if (loading || state.revision === previous.revision) return;
        pending ||= window.setTimeout(() => void postChange(), 0);
      });
      await repository.save(document);
      await openDocument(document.metadata.id);
      if (disposed) return;
      // Opening normalises what it read; that alone must not dirty the file. A new file is the
      // exception: it gets its first contents now.
      hostText = blank ? null : serializeDocument(useEditorStore.getState().document);
      if (blank) await postChange();
    };

    const openNewest = async () => {
      const message = queued;
      queued = null;
      if (!message || disposed) return;
      loading = true;
      try {
        await open(message);
      } finally {
        loading = false;
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !isHostOrigin(event.origin)) return;
      const data = event.data as Partial<LoadMessage> | null;
      if (data?.type !== 'draft-canvas:load' || typeof data.text !== 'string') return;
      hostOrigin = event.origin;
      if (data.text === hostText && !queued) return;
      window.clearTimeout(pending);
      pending = 0;
      queued = { type: data.type, text: data.text, title: typeof data.title === 'string' ? data.title : undefined };
      loads = loads.then(openNewest);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void (async () => {
        if (pending) {
          window.clearTimeout(pending);
          await postChange();
        }
        post({ type: 'draft-canvas:save', saveAs: event.shiftKey });
      })();
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown, true);
    // No data in it, so any parent may hear it; the document only ever goes to the host's origin.
    window.parent.postMessage({ type: 'draft-canvas:ready', protocol: HOST_PROTOCOL } satisfies ToHostMessage, '*');

    return () => {
      disposed = true;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown, true);
      window.clearTimeout(pending);
      unsubscribe?.();
    };
  }, [ready, repository, openDocument]);

  return error;
}
