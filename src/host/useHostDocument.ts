import { useEffect, useMemo, useRef, useState } from 'react';
import { createDocument } from '../document/factory';
import { deserializeDocument, serializeDocument } from '../export/project';
import { logDiagnostic } from '../lib/diagnostics';
import { isEditableTarget } from '../lib/isEditableTarget';
import { useUiStore } from '../store/uiStore';
import type { DocumentSession } from '../store/useDocumentSession';
import type { HostChannel } from './channel';
import {
  chordOf,
  embeddedHost,
  type BackgroundMessage,
  type ClipboardMessage,
  type CommandMessage,
  type LoadMessage,
  type ToHostMessage,
} from './embeddedHost';
import { hostClipboard, setHostClipboard, type HostClipboard } from './hostClipboard';
import { base64ToBlob, blobToBase64 } from './hostBackground';
import { handleTextChord } from './hostTextEditing';
import { vscodeChannel } from './vscodeChannel';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const CLIPBOARD_READ_TIMEOUT_MS = 1500;
const BACKGROUND_READ_TIMEOUT_MS = 3000;

export interface HostDocumentState {
  /** Why the file couldn't be opened, if it couldn't. */
  error: string | null;
  /** The file's text stopped being a diagram (mid-typing in a text editor beside the canvas, say):
   *  the canvas keeps the last version that was, and writes nothing back until the file is valid. */
  invalidWhileOpen: boolean;
}

/**
 * Connects the open document to the host's file when a host owns it: VS Code framing the app (see
 * `embeddedHost`), or the desktop shell in this same page. Which one is the `channel`'s business;
 * what is said across it is the same for both.
 *
 * The host sends the file's text; every committed edit goes straight back as the whole serialized
 * document. There's no debounce: the host can remove the frame at any moment (closing its tab never
 * blurs the frame first), so anything not already posted would be lost. ⌘S is forwarded because a
 * key pressed inside a cross-origin frame never reaches the host's own shortcuts — and neither do the
 * others the host lists (⌘P, ⌘W), nor Select All, Copy, Cut, Paste and Undo in a text field, which the
 * app does itself. Links to other sites go to the host too, since the frame isn't allowed to open a window.
 *
 * With no `channel` given, VS Code's is used when the app is framed by it, and nothing happens otherwise.
 */
export function useHostDocument(session: DocumentSession, channel?: HostChannel | null): HostDocumentState {
  const [state, setState] = useState<HostDocumentState>({ error: null, invalidWhileOpen: false });
  const { ready, repository, openDocument } = session;
  const framed = useMemo(() => (embeddedHost ? vscodeChannel() : null), []);
  const host = channel ?? framed;

  // Read through a ref: the session is a new object on every render, and putting it in the effect's
  // dependencies would tear the host down and set it up again on each one.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  });

  // Only the desktop shell needs to hear that Home is showing again (its own Back button is one way
  // there, an error screen another): it settles what it holds for the file that was open.
  const openId = session.openId;
  const shownOpenId = useRef<string | null>(null);
  useEffect(() => {
    const was = shownOpenId.current;
    shownOpenId.current = openId;
    if (host?.kind === 'desktop' && was && !openId) host.post({ type: 'draft-canvas:closed' });
  }, [openId, host]);

  useEffect(() => {
    if (!host || !ready || !repository) return;

    // The text the host holds right now, so reopening or echoing it back never dirties the file.
    let hostText: string | null = null;
    // The `seq` of the load the canvas is showing, echoed on every change so the host can drop an
    // edit made to contents it has since replaced (see `LoadMessage.seq`).
    let shownSeq: number | undefined;
    // The document on screen. A host that opens file after file (the desktop's Home) would otherwise
    // leave every earlier one, and its background image, in memory for as long as the app runs.
    let shownId: string | null = null;
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

    const post = (message: ToHostMessage) => host.post(message);

    // What the host said it does for the app (see `LoadMessage`): none of it is used until then.
    let textEditing = false;
    let hostKeys = new Set<string>();
    let hostKeepsBackground = false;

    let clipboardReadId = 0;
    const clipboardReads = new Map<number, (text: string | null) => void>();
    const clipboard: HostClipboard = {
      write: (text, plain) => post({ type: 'draft-canvas:clipboard-write', text, ...(plain ? { plain } : {}) }),
      read: (plain) =>
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
          post({ type: 'draft-canvas:clipboard-read', id, ...(plain ? { plain } : {}) });
        }),
    };

    let backgroundReadId = 0;
    const backgroundReads = new Map<number, (image: Partial<BackgroundMessage>) => void>();
    /** The host's stored image, or null when it has none — or doesn't answer, which mustn't hold the file's opening. */
    const readBackground = () =>
      new Promise<Blob | null>((resolve) => {
        const id = ++backgroundReadId;
        const settle = (reply: Partial<BackgroundMessage>) => {
          window.clearTimeout(timeout);
          backgroundReads.delete(id);
          try {
            resolve(typeof reply.data === 'string' && typeof reply.mime === 'string' ? base64ToBlob(reply.data, reply.mime) : null);
          } catch {
            resolve(null);
          }
        };
        const timeout = window.setTimeout(() => settle({}), BACKGROUND_READ_TIMEOUT_MS);
        backgroundReads.set(id, settle);
        post({ type: 'draft-canvas:background-read', id });
      });

    /** The file turns on a background the app doesn't hold yet (a fresh tab, memory only): fetch it from the host. */
    const restoreBackground = async (document: { metadata: { id: string }; settings: { background: { enabled: boolean; imageId?: string } } }) => {
      const { enabled, imageId } = document.settings.background;
      if (!hostKeepsBackground || !enabled || !repository) return;
      const id = document.metadata.id;
      if (await repository.loadBackgroundImage(id, imageId)) return;
      const blob = await readBackground();
      if (!blob) return;
      try {
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        bitmap.close();
        await repository.saveBackgroundImage(id, blob, { width, height }, imageId);
      } catch (error) {
        // An image that can't be read is the same as none: the canvas shows no background.
        logDiagnostic(error, { operation: 'host-background-restore' });
      }
    };

    // Reports run one after another, so a quick change of mind can't be overtaken by the first.
    let backgroundReports = Promise.resolve();
    const reportBackground = (documentId: string, background: { enabled: boolean; imageId?: string }) => {
      backgroundReports = backgroundReports
        .then(async () => {
          if (!repository) return;
          if (!background.enabled) {
            post({ type: 'draft-canvas:background-remove' });
            return;
          }
          const image = await repository.loadBackgroundImage(documentId, background.imageId);
          if (image) post({ type: 'draft-canvas:background-write', mime: image.blob.type || 'image/png', data: await blobToBase64(image.blob) });
        })
        .catch((error: unknown) => logDiagnostic(error, { operation: 'host-background-report' }));
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
        // Only the image itself is the host's to keep; how it's drawn (dim, blur) is in the file.
        const now = current.document.settings.background;
        const was = previous.document.settings.background;
        if (hostKeepsBackground && (now.enabled !== was.enabled || now.imageId !== was.imageId)) {
          reportBackground(current.document.metadata.id, now);
        }
      });
      await repository.save(document);
      // Before the canvas is shown, which looks for the image only once.
      await restoreBackground(document);
      await openDocument(document.metadata.id);
      if (disposed) return;
      const previousId = shownId;
      shownId = document.metadata.id;
      if (previousId && previousId !== shownId) {
        await repository.remove(previousId).catch((error: unknown) => logDiagnostic(error, { operation: 'host-forget' }));
      }
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
      if (hostText !== null) host.opened?.({ text: hostText, seq });
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

    // What the channel hands over has already passed its check of who sent it.
    const onMessage = (message: unknown) => {
      const reply = message as (Partial<ClipboardMessage> & Partial<BackgroundMessage>) | null;
      if (reply?.type === 'draft-canvas:clipboard') {
        if (typeof reply.id === 'number') clipboardReads.get(reply.id)?.(typeof reply.text === 'string' ? reply.text : null);
        return;
      }
      if (reply?.type === 'draft-canvas:background') {
        if (typeof reply.id === 'number') backgroundReads.get(reply.id)?.(reply);
        return;
      }
      const command = message as Partial<CommandMessage> | null;
      if (command?.type === 'draft-canvas:command') {
        if (command.command === 'flush' && typeof command.id === 'number') {
          const id = command.id;
          void flush().then(() => post({ type: 'draft-canvas:flushed', id }));
        } else if (command.command === 'close') {
          void sessionRef.current.closeDocument();
        }
        return;
      }
      const data = message as Partial<LoadMessage> | null;
      if (data?.type !== 'draft-canvas:load' || typeof data.text !== 'string') return;
      if (data.clipboard === true) setHostClipboard(clipboard);
      textEditing = data.clipboard === true && data.textEditing === true;
      hostKeepsBackground = data.background === true;
      hostKeys = new Set(Array.isArray(data.keys) ? data.keys.filter((chord): chord is string => typeof chord === 'string') : []);
      const seq = typeof data.seq === 'number' ? data.seq : undefined;
      // Only while a document is open: after Home has been showing, the same text is a file to open again.
      if (data.text === hostText && !queued && !invalid && sessionRef.current.openId !== null) {
        // Already showing it (the host re-sent what it got from here): only the numbering moves on.
        shownSeq = seq;
        host.opened?.({ text: hostText, seq });
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

    /** Lets go of a field still being typed in and posts every edit still pending, so the host acts on
     *  exactly what is on screen. Text being typed (a label, an inspector field) only reaches the document
     *  when its field lets go, so without this a save — or a tab closing — would miss what was just typed. */
    const flush = async () => {
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
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (textEditing && handleTextChord(event, clipboard)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void flush().then(() => post({ type: 'draft-canvas:save', saveAs: event.shiftKey }));
        return;
      }
      const chord = event.repeat ? null : chordOf(event);
      if (!chord || !hostKeys.has(chord)) return;
      // Whether the app used it is only known once every listener has run: its own ⌘K, ⌘E and the rest win.
      window.setTimeout(() => {
        if (!event.defaultPrevented) void flush().then(() => post({ type: 'draft-canvas:key', chord }));
      }, 0);
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

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('click', onLinkClick, true);
    window.addEventListener('auxclick', onLinkClick, true);
    // Starting the channel is what tells the host the app is ready to be sent a file.
    const stop = host.start(onMessage);

    return () => {
      disposed = true;
      stop();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('click', onLinkClick, true);
      window.removeEventListener('auxclick', onLinkClick, true);
      window.clearTimeout(pending);
      unsubscribe?.();
      if (hostClipboard() === clipboard) setHostClipboard(null);
      for (const settle of [...clipboardReads.values()]) settle(null);
      for (const settle of [...backgroundReads.values()]) settle({});
    };
  }, [ready, repository, openDocument, host]);

  return state;
}
