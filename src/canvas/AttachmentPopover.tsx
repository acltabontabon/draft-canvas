import { useEffect, useRef } from 'react';
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
  card: 'Card',
  rounded: 'Card',
};

function summarize(attachment: Attachment): string {
  const body = attachment.type === 'code' ? attachment.code : attachment.text;
  const trimmed = (body ?? '').trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : `Empty ${TYPE_LABELS[attachment.type].toLowerCase()}`;
}

/**
 * The lightweight floating panel a node's attachment badge opens. Deliberately
 * not a permanent inspector — it exists only while `openAttachmentPopover`
 * names a host, anchored to that node in flow space (so it pans and zooms
 * with the canvas, the same as an edge label) rather than docked anywhere.
 */
export function AttachmentPopover() {
  const hostId = useUiStore((state) => state.openAttachmentPopover);
  const setOpen = useUiStore((state) => state.setOpenAttachmentPopover);
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

  if (!hostId || !host || !host.attachments?.length) return null;
  const attachments = host.attachments;

  return (
    <ViewportPortal>
      <div
        ref={panel}
        className="dc-attachment-popover"
        role="dialog"
        aria-label={`Attachments for ${host.text || 'this node'}`}
        style={{ transform: `translate(${host.x + host.width + 14}px, ${host.y}px)` }}
        onPointerDown={(event) => event.stopPropagation()}
      >
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
                      updateAttachment(host.id, attachment.id, {
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
                      updateAttachment(host.id, attachment.id, {
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
                    onClick={() => reorderAttachment(host.id, attachment.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={index === attachments.length - 1}
                    onClick={() => reorderAttachment(host.id, attachment.id, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title="Detach onto the canvas"
                    onClick={() => detachAttachment(host.id, attachment.id)}
                  >
                    Detach
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => removeAttachment(host.id, attachment.id)}
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
                      updateAttachment(host.id, attachment.id, { code: value });
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
                      updateAttachment(host.id, attachment.id, { text: value });
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </ViewportPortal>
  );
}
