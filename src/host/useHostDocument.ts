import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createDocument } from '../document/factory';
import { realRepairs } from '../document/validate';
import { deserializeDocument, serializeDocument } from '../export/project';
import { logDiagnostic } from '../lib/diagnostics';
import { isEditableTarget } from '../lib/isEditableTarget';
import { useUiStore } from '../store/uiStore';
import type { DocumentSession } from '../store/useDocumentSession';
import type { HostChannel } from './channel';
import type { CommandMessage, LoadMessage, ToHostMessage } from './embeddedHost';
import { watchTyping } from '../lib/recentTyping';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
/** How long edits gather before the file is posted. Each post serializes the whole file and compares
 *  it with what the host holds, which on a large diagram is too much to do for every nudge; the host
 *  asks for a flush before anything that reads the text (save, Save As, leaving the file, quitting,
 *  an agent's read or commit), so only its dirty dot and its crash copy wait this long. */
const CHANGE_POST_MS = 150;

export interface HostDocumentState {
  /** Why the file couldn't be opened, if it couldn't. */
  error: string | null;
  /** The file's text stopped being a diagram (mid-typing in a text editor beside the canvas, say):
   *  the canvas keeps the last version that was, and writes nothing back until the file is valid. */
  invalidWhileOpen: boolean;
}

/**
 * Connects the open document to the host's file when a host owns it: the desktop shell, in this
 * same page (`src/desktop/channel.ts`). With no `channel` given nothing happens — the web app owns
 * its own documents.
 *
 * The host sends the file's text; committed edits go back as the whole serialized document, gathered
 * for `CHANGE_POST_MS` at most. Whatever the host does with the text it first asks for a flush, which
 * posts what is still waiting at once. ⌘S is forwarded so the shell saves; links to other sites go to
 * the host too, which opens them in the system browser.
 */
export function useHostDocument(session: DocumentSession, channel?: HostChannel | null): HostDocumentState {
  const [state, setState] = useState<HostDocumentState>({ error: null, invalidWhileOpen: false });
  const { ready, repository, openDocument } = session;
  const host = channel ?? null;

  // Read through a ref: the session is a new object on every render, and putting it in the effect's
  // dependencies would tear the host down and set it up again on each one.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  });

  // The `seq` of the load the canvas is showing, echoed on every change and on `closed` so the host
  // can drop what was said about contents it has since replaced (see `LoadMessage.seq`).
  const shownSeq = useRef<number | undefined>(undefined);

  // Only the desktop shell needs to hear that Home is showing again (its own Back button is one way
  // there, an error screen another): it settles what it holds for the file that was open. Said in the
  // commit that takes the canvas away, with the load it was showing. As a passive effect it ran a
  // task or more after that commit on a big diagram, by when ⌘N's new Quick Draft could already be
  // sent and shown: the shell took the draft for what was closed, and dropped every edit made to it.
  const openId = session.openId;
  const shownOpenId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = shownOpenId.current;
    shownOpenId.current = openId;
    if (host?.kind !== 'desktop' || !was || openId) return;
    const seq = shownSeq.current;
    host.post({ type: 'draft-canvas:closed', ...(seq !== undefined ? { seq } : {}) });
  }, [openId, host]);

  useEffect(() => {
    if (!host || !ready || !repository) return;
    // An agent's change waits while someone is typing (`agentBridge.ts`'s `busyReason`), which only
    // keystrokes seen from here on can tell.
    if (host.kind === 'desktop') watchTyping();

    // The text the host holds right now, so reopening or echoing it back never dirties the file.
    let hostText: string | null = null;
    // The document on screen. A host that opens file after file (the desktop's Home) would otherwise
    // leave every earlier one in memory for as long as the app runs.
    let shownId: string | null = null;
    let opened = false;
    // Set while the file's text isn't a diagram: an edit here would overwrite what the user is typing.
    let invalid = false;
    let pending = 0;
    let lastChange: Promise<void> = Promise.resolve();
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    // Loads run one at a time, and only the newest waiting one runs: a host can send the file twice
    // in quick succession (on restore, the saved text and then the unsaved edits it kept), and an
    // older load finishing last would show — and then write back — stale contents.
    let queued: LoadMessage | null = null;
    let loading = false;
    let loads = Promise.resolve();
    // How many times the host has asked for the canvas to close: a close that arrives while a load
    // is being read takes the screen from it (`open`).
    let closeRequests = 0;

    const post = (message: ToHostMessage) => host.post(message);

    const postChange = async () => {
      pending = 0;
      if (invalid) return;
      const { useEditorStore, fileWithLiveViewport } = await import('../store/editorStore');
      const text = serializeDocument(fileWithLiveViewport(useEditorStore.getState()));
      if (text === hostText) return;
      hostText = text;
      const baseSeq = shownSeq.current;
      post({ type: 'draft-canvas:change', text, ...(baseSeq !== undefined ? { baseSeq } : {}) });
    };

    const sendChange = () => {
      lastChange = postChange().catch((error: unknown) => logDiagnostic(error, { operation: 'host-change' }));
      return lastChange;
    };

    /** Posts the waiting edits now rather than when their timer comes round. */
    const sendPending = () => {
      window.clearTimeout(pending);
      return sendChange();
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
        // Armed once and not pushed back by later edits, so a long drag or a held arrow key still
        // reaches the host every `CHANGE_POST_MS`.
        pending ||= window.setTimeout(() => void sendChange(), CHANGE_POST_MS);
      });
      await repository.save(document);
      const closes = closeRequests;
      await openDocument(document.metadata.id);
      if (disposed) return;
      // Back pressed while this was still being read (⌘N, then Back at once): the close is the newer
      // navigation, so the canvas was never shown and Home is. That close was said with the number of
      // the load shown before this one, which the host had already replaced, so the host never heard
      // it and kept this one for open over Home. Said again here, with this load's number.
      const superseded = closeRequests !== closes;
      // Numbered at once otherwise, before anything else is awaited: a close from here on is this load's.
      if (!superseded) shownSeq.current = seq;
      const previousId = shownId;
      shownId = document.metadata.id;
      if (previousId && previousId !== shownId) {
        await repository.remove(previousId).catch((error: unknown) => logDiagnostic(error, { operation: 'host-forget' }));
      }
      if (superseded) {
        post({ type: 'draft-canvas:closed', ...(seq !== undefined ? { seq } : {}) });
        return;
      }
      opened = true;
      invalid = false;
      setState({ error: null, invalidWhileOpen: false });
      // Said out loud, as an import in the Library does: the file itself still holds the original,
      // and the first edit writes the repaired document over it.
      const repaired = parsed ? realRepairs(parsed.repairs) : [];
      if (repaired.length > 0) {
        useUiStore.getState().notify(`Opened with repairs, saved to the file on your next edit: ${repaired.join(' ')}`);
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
      const command = message as Partial<CommandMessage> | null;
      if (command?.type === 'draft-canvas:command') {
        if (command.command === 'flush' && typeof command.id === 'number') {
          const id = command.id;
          // An agent's flush (see `desktop/controller.ts`) keeps the field the person is typing in.
          const keepFocus = command.keepFocus === true;
          void flush({ keepFocus })
            .then(() => post({ type: 'draft-canvas:flushed', id }))
            .catch((error: unknown) => logDiagnostic(error, { operation: 'host-flush-ack' }));
        } else if (command.command === 'close') {
          closeRequests += 1;
          void sessionRef.current.closeDocument();
        } else if (__DESKTOP__ && command.command === 'agent' && host.kind === 'desktop' && typeof command.id === 'number' && command.request) {
          const id = command.id;
          const request = command.request;
          void (async () => {
            const { handleAgentRequest } = await import('./agentBridge');
            const reply = handleAgentRequest(request);
            // The shell decides whether to save from the text it holds, so the change is posted first.
            if (reply.kind === 'committed') await sendPending();
            post({ type: 'draft-canvas:agent', id, reply });
          })().catch((error: unknown) => logDiagnostic(error, { operation: 'host-agent' }));
        }
        return;
      }
      const data = message as Partial<LoadMessage> | null;
      if (data?.type !== 'draft-canvas:load' || typeof data.text !== 'string') return;
      const seq = typeof data.seq === 'number' ? data.seq : undefined;
      // Only while a document is open: after Home has been showing, the same text is a file to open again.
      if (data.text === hostText && !queued && !invalid && sessionRef.current.openId !== null) {
        // Already showing it (the host re-sent what it got from here): only the numbering moves on.
        shownSeq.current = seq;
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
     *  when its field lets go, so without this a save — or a tab closing — would miss what was just typed.
     *  `keepFocus` posts only what has already reached the document, for a caller that must not
     *  interrupt the typing. */
    const flush = async ({ keepFocus = false }: { keepFocus?: boolean } = {}) => {
      const active = document.activeElement;
      if (!keepFocus && isEditableTarget(active)) {
        (active as HTMLElement).blur();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      if (pending) {
        await sendPending();
      } else {
        await lastChange;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void flush()
        .then(() => post({ type: 'draft-canvas:save', saveAs: event.shiftKey }))
        .catch((error: unknown) => logDiagnostic(error, { operation: 'host-save-request' }));
    };

    const onLinkClick = (event: MouseEvent) => {
      if (event.button > 1 || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || !EXTERNAL_PROTOCOLS.has(link.protocol)) return;
      // Only a jump within this page stays here. Any other page opens in the system browser, through
      // the host.
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
    };
  }, [ready, repository, openDocument, host]);

  return state;
}
