import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewportPortal } from '@xyflow/react';
import {
  ATTACHABLE_TYPES,
  CODE_LANGUAGES,
  NOTE_KINDS,
  type Attachment,
  type CodeLanguage,
  type NoteKind,
} from '../document/types';
import { LANGUAGE_LABELS } from '../render/code/highlight';
import { useEditorStore } from '../store/editorStore';
import { selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';

const NOTE_LABELS: Record<NoteKind, string> = {
  note: 'Note',
  question: 'Question',
  warning: 'Warning',
  decision: 'Decision',
};

const TYPE_LABELS: Record<(typeof ATTACHABLE_TYPES)[number], string> = {
  code: 'Code',
  note: 'Note',
  text: 'Text',
};

function summarize(attachment: Attachment): string {
  const body = attachment.type === 'code' ? attachment.code : attachment.text;
  const trimmed = (body ?? '').trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : `Empty ${TYPE_LABELS[attachment.type].toLowerCase()}`;
}

/** Must match the `dc-attachment-card-in`/`-out` keyframe duration in `canvas.css`. */
const POPOVER_EXIT_MS = 120;

/**
 * The lightweight floating panel a node's attachment badge opens. Deliberately
 * not a permanent inspector — it exists only while `openAttachmentDetail`
 * names this node as the open host, anchored to that node in flow space (so
 * it pans and zooms with the canvas, the same as an edge label) rather than
 * docked anywhere.
 */
export function AttachmentPopover() {
  const hostId = useUiStore((state) => (state.openAttachmentDetail?.hostKind === 'node' ? state.openAttachmentDetail.hostId : null));
  const setOpenAttachmentDetail = useUiStore((state) => state.setOpenAttachmentDetail);
  const setOpen = useCallback(
    (next: string | null) =>
      setOpenAttachmentDetail(next ? { hostKind: 'node', hostId: next, attachmentId: null } : null),
    [setOpenAttachmentDetail],
  );
  const host = useEditorStore((state) => (hostId ? selectNode(state.document, hostId) : undefined));
  const updateAttachment = useEditorStore((state) => state.updateAttachment);
  const detachAttachment = useEditorStore((state) => state.detachAttachment);
  const removeAttachment = useEditorStore((state) => state.removeAttachment);
  const reorderAttachment = useEditorStore((state) => state.reorderAttachment);

  const panel = useRef<HTMLDivElement>(null);

  // Detaching or deleting the last attachment must close the popover, not
  // just stop rendering it — otherwise the open state lingers and the next
  // click on the badge (which toggles) reads as "already open" and closes
  // instead of opening.
  useEffect(() => {
    if (hostId && host && !host.attachments?.length) setOpen(null);
  }, [hostId, host, setOpen]);

  const open = Boolean(hostId && host?.attachments?.length);

  // Mirrors `AttachmentChip` in `AttachmentPresentation.tsx`: closing this panel is a state flip
  // (`openAttachmentDetail` going null), and React would otherwise remove the DOM node the
  // instant that happens, cutting off any fade-out mid-frame. So the panel stays mounted for one
  // more tick, marked `data-closing`, so `canvas.css` can play the reverse animation first.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const hideTimer = useRef<number | null>(null);

  // `host`/`host.attachments` go away the instant `open` flips false (the store id is cleared, or
  // the node itself was deleted) — so the last live values are cached here for the panel to keep
  // rendering *something* coherent while it fades out, instead of going blank a frame early.
  const lastHostRef = useRef(host);
  const lastAttachmentsRef = useRef(host?.attachments);
  if (open) {
    lastHostRef.current = host;
    lastAttachmentsRef.current = host?.attachments;
  }

  useEffect(() => {
    if (open) {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setClosing(false);
      setMounted(true);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    hideTimer.current = window.setTimeout(
      () => {
        setMounted(false);
        setClosing(false);
        hideTimer.current = null;
      },
      reduceMotion ? 0 : POPOVER_EXIT_MS,
    );
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
    // mounted intentionally excluded: it's only ever flipped by this effect's own timeout, so
    // reacting to it here would just re-run the same branch redundantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!hostId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(null);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [hostId, setOpen]);

  if (!mounted) return null;
  const displayHost = open ? host : lastHostRef.current;
  const attachments = (open ? host?.attachments : lastAttachmentsRef.current) ?? [];
  if (!displayHost || !attachments.length) return null;

  return (
    <ViewportPortal>
      <div
        ref={panel}
        className="dc-attachment-popover"
        role="dialog"
        aria-label={`Attachments for ${displayHost.text || 'this node'}`}
        data-closing={closing ? 'true' : undefined}
        style={{ transform: `translate(${displayHost.x + displayHost.width + 14}px, ${displayHost.y}px)` }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* The reveal/close animation lives on this inner wrapper, not the positioned outer div —
            a CSS animation replaces the whole `transform` property for its duration, so animating
            scale here would otherwise clobber the outer div's own positioning translate. */}
        <div className="dc-attachment-popover-inner">
          <header className="dc-attachment-popover-header">
            Attachments
            <button type="button" className="dc-attachment-popover-close" onClick={() => setOpen(null)}>
              ×
            </button>
          </header>
          <ul className="dc-attachment-list">
            {attachments.map((attachment, index) => (
              <li key={attachment.id} className="dc-attachment-row">
                <div className="dc-attachment-row-head">
                  <span className="dc-attachment-type">{TYPE_LABELS[attachment.type]}</span>

                  {attachment.type === 'code' && (
                    <select
                      className="dc-select"
                      aria-label="Attachment language"
                      value={attachment.language ?? 'plaintext'}
                      onChange={(event) =>
                        updateAttachment(displayHost.id, attachment.id, {
                          language: event.target.value as CodeLanguage,
                        })
                      }
                    >
                      {CODE_LANGUAGES.map((language) => (
                        <option key={language} value={language}>
                          {LANGUAGE_LABELS[language]}
                        </option>
                      ))}
                    </select>
                  )}

                  {attachment.type === 'note' && (
                    <select
                      className="dc-select"
                      aria-label="Attachment note kind"
                      value={attachment.noteKind ?? 'note'}
                      onChange={(event) =>
                        updateAttachment(displayHost.id, attachment.id, {
                          noteKind: event.target.value as NoteKind,
                        })
                      }
                    >
                      {NOTE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {NOTE_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  )}

                  <div className="dc-attachment-row-actions">
                    <button
                      type="button"
                      title="Move up"
                      disabled={index === 0}
                      onClick={() => reorderAttachment(displayHost.id, attachment.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Move down"
                      disabled={index === attachments.length - 1}
                      onClick={() => reorderAttachment(displayHost.id, attachment.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      title="Detach onto the canvas"
                      onClick={() => detachAttachment(displayHost.id, attachment.id)}
                    >
                      Detach
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => removeAttachment(displayHost.id, attachment.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {attachment.type === 'code' ? (
                  <textarea
                    className="dc-attachment-editor dc-attachment-editor-code"
                    spellCheck={false}
                    defaultValue={attachment.code ?? ''}
                    placeholder={summarize(attachment)}
                    onBlur={(event) => {
                      const value = event.currentTarget.value;
                      if (value !== (attachment.code ?? '')) {
                        updateAttachment(displayHost.id, attachment.id, { code: value });
                      }
                    }}
                  />
                ) : (
                  <textarea
                    className="dc-attachment-editor"
                    defaultValue={attachment.text ?? ''}
                    placeholder={summarize(attachment)}
                    onBlur={(event) => {
                      const value = event.currentTarget.value;
                      if (value !== (attachment.text ?? '')) {
                        updateAttachment(displayHost.id, attachment.id, { text: value });
                      }
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ViewportPortal>
  );
}
