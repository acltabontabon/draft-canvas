import { useEffect, useState } from 'react';
import { createDocument } from '../document/factory';
import { deserializeDocument, serializeDocument } from '../export/project';
import { logDiagnostic } from '../lib/diagnostics';
import { isEditableTarget } from '../lib/isEditableTarget';
import { useUiStore } from '../store/uiStore';
import type { DocumentSession } from '../store/useDocumentSession';
import {
  embeddedHost,
  HOST_PROTOCOL,
  isHostOrigin,
  type ClipboardMessage,
  type LoadMessage,
  type ToHostMessage,
} from './embeddedHost';
import { hostClipboard, setHostClipboard, type HostClipboard } from './hostClipboard';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const CLIPBOARD_READ_TIMEOUT_MS = 1500;

export interface HostDocumentState {
  /** Why the file couldn't be opened, if it couldn't. */
  error: string | null;
  /** The file's text stopped being a diagram (mid-typing in a text editor beside the canvas, say):
   *  the canvas keeps the last version that was, and writes nothing back until the file is valid. */
  invalidWhileOpen: boolean;
}

/**
 * Connects the open document to the host's file when the app is embedded (see `embeddedHost`).
 *
 * The host sends the file's text; every committed edit goes straight back as the whole serialized
 * document. There's no debounce: the host can remove the frame at any moment (closing its tab never
 * blurs the frame first), so anything not already posted would be lost. ⌘S is forwarded because a
 * key pressed inside a cross-origin frame never reaches the host's own shortcuts. Links to other sites
 * go to the host too, since the frame isn't allowed to open a window.
 */
export function useHostDocument(session: DocumentSession): HostDocumentState {
  const [state, setState] = useState<HostDocumentState>({ error: null, invalidWhileOpen: false });
  const { ready, repository, openDocument } = session;

  useEffect(() => {
    if (!embeddedHost || !ready || !repository) return;

    let hostOrigin: string | null = null;
    // The text the host holds right now, so reopening or echoing it back never dirties the file.
    let hostText: string | null = null;
    // The `seq` of the load the canvas is showing, echoed on every change so the host can drop an
    // edit made to contents it has since replaced (see `LoadMessage.seq`).
    let shownSeq: number | undefined;
    let opened = false;
    // Set while the file's text isn't a diagram: an edit here would overwrite what the user is typing.
    let invalid = false;
    let pending = 0;
    let lastChange: Promise<void> = Promise.resolve();
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

    let clipboardReadId = 0;
    const clipboardReads = new Map<number, (text: string | null) => void>();
    const clipboard: HostClipboard = {
      write: (text) => post({ type: 'draft-canvas:clipboard-write', text }),
      read: () =>
        new Promise((resolve) => {
          const id = ++clipboardReadId;
          const settle = (text: string | null) => {
            window.clearTimeout(timeout);
            clipboardReads.delete(id);
            resolve(text);
          };
          // A paste waits on this; a host that never answers mustn't hold it forever.
          const timeout = window.setTimeout(() => settle(null), CLIPBOARD_READ_TIMEOUT_MS);
          clipboardReads.set(id, settle);
          post({ type: 'draft-canvas:clipboard-read', id });
        }),
    };

    const postChange = async () => {
      pending = 0;
      if (invalid) return;
      const { useEditorStore, fileWithLiveViewport } = await import('../store/editorStore');
      const text = serializeDocument(fileWithLiveViewport(useEditorStore.getState()));
      if (text === hostText) return;
      hostText = text;
      post({ type: 'draft-canvas:change', text, ...(shownSeq !== undefined ? { baseSeq: shownSeq } : {}) });
    };

    const sendChange = () => {
      lastChange = postChange().catch((error: unknown) => logDiagnostic(error, { operation: 'host-change' }));
      return lastChange;
    };

    const open = async ({ text, title, seq }: LoadMessage) => {
      const blank = text.trim() === '';
      const parsed = blank ? null : deserializeDocument(text);
      if (parsed && !parsed.ok) {
        // Keeps showing the last valid version, if there is one — and stops writing, since the
        // user's own text is what's in the file now.
        if (opened) invalid = true;
        setState({ error: parsed.error, invalidWhileOpen: opened });
        return;
      }
      const document = parsed ? parsed.document : createDocument(title || undefined);
      const { useEditorStore, fileWithLiveViewport } = await import('../store/editorStore');
      if (disposed) return;
      unsubscribe ??= useEditorStore.subscribe((current, previous) => {
        // Revisions only: panning alone moves the viewport, and a file shouldn't turn dirty for that.
        // Nor does opening a document count as an edit of it.
        if (loading || current.revision === previous.revision) return;
        pending ||= window.setTimeout(() => void sendChange(), 0);
      });
      await repository.save(document);
      await openDocument(document.metadata.id);
      if (disposed) return;
      opened = true;
      invalid = false;
      shownSeq = seq;
      setState({ error: null, invalidWhileOpen: false });
      // Said out loud, as an import in the Library does: the file itself still holds the original,
      // and the first edit writes the repaired document over it.
      if (parsed && parsed.repairs.length > 0) {
        useUiStore.getState().notify(`Opened with repairs, saved to the file on your next edit: ${parsed.repairs.join(' ')}`);
      }
      // Opening normalises what it read; that alone must not dirty the file. A new file is the
      // exception: it gets its first contents now.
      hostText = blank ? null : serializeDocument(fileWithLiveViewport(useEditorStore.getState()));
      if (blank) await sendChange();
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
      const reply = event.data as Partial<ClipboardMessage> | null;
      if (reply?.type === 'draft-canvas:clipboard') {
        if (typeof reply.id === 'number') clipboardReads.get(reply.id)?.(typeof reply.text === 'string' ? reply.text : null);
        return;
      }
      const data = event.data as Partial<LoadMessage> | null;
      if (data?.type !== 'draft-canvas:load' || typeof data.text !== 'string') return;
      hostOrigin = event.origin;
      if (data.clipboard === true) setHostClipboard(clipboard);
      const seq = typeof data.seq === 'number' ? data.seq : undefined;
      if (data.text === hostText && !queued && !invalid) {
        // Already showing it (the host re-sent what it got from here): only the numbering moves on.
        shownSeq = seq;
        return;
      }
      window.clearTimeout(pending);
      pending = 0;
      queued = { type: data.type, text: data.text, title: typeof data.title === 'string' ? data.title : undefined, seq };
      // A load that throws (the editor's chunk failing to arrive, storage refusing) must not stop
      // every later one from running.
      loads = loads.then(openNewest).catch((error: unknown) => {
        logDiagnostic(error, { operation: 'host-load' });
        if (!opened && !disposed) setState({ error: 'The editor could not be loaded. Reopen the file to try again.', invalidWhileOpen: false });
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void (async () => {
        // Text still being typed (a label, an inspector field) only reaches the document when its
        // field lets go — so let go first, or the save would miss exactly what was just typed.
        const active = document.activeElement;
        if (isEditableTarget(active)) {
          (active as HTMLElement).blur();
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
        if (pending) {
          window.clearTimeout(pending);
          await sendChange();
        } else {
          await lastChange;
        }
        post({ type: 'draft-canvas:save', saveAs: event.shiftKey });
      })();
    };

    const onLinkClick = (event: MouseEvent) => {
      if (event.button > 1 || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || !EXTERNAL_PROTOCOLS.has(link.protocol)) return;
      // Only a jump within this page stays here. Any other page — this site's own home page included
      // — would need a new window, which the frame isn't allowed to open.
      const inPage =
        link.origin === window.location.origin &&
        link.pathname === window.location.pathname &&
        link.search === window.location.search &&
        link.hash !== '';
      if (inPage) return;
      event.preventDefault();
      post({ type: 'draft-canvas:open-external', url: link.href });
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', onLinkClick, true);
    window.addEventListener('auxclick', onLinkClick, true);
    // No data in it, so any parent may hear it; the document only ever goes to the host's origin.
    window.parent.postMessage({ type: 'draft-canvas:ready', protocol: HOST_PROTOCOL } satisfies ToHostMessage, '*');

    return () => {
      disposed = true;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('click', onLinkClick, true);
      window.removeEventListener('auxclick', onLinkClick, true);
      window.clearTimeout(pending);
      unsubscribe?.();
      if (hostClipboard() === clipboard) setHostClipboard(null);
      for (const settle of [...clipboardReads.values()]) settle(null);
    };
  }, [ready, repository, openDocument]);

  return state;
}
