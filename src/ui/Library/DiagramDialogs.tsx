import { useState } from 'react';
import type { DraftSummary } from '../../document/types';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { Button } from '../common/Button';
import { Modal } from '../common/LazyModal';

/** The rename and delete dialogs for one diagram, shared by Home's shelf and the gallery. */
export function RenameDialog({
  entry,
  onClose,
  onSubmit,
}: {
  entry: DraftSummary;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState(entry.title);
  // An empty title is simply not submittable (the button says so by being disabled) — not a silent close.
  const submit = () => {
    const title = value.trim();
    if (title) onSubmit(title);
  };

  return (
    <Modal
      title="Rename"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" icon="check" disabled={!value.trim()} onClick={submit}>
            Rename
          </Button>
        </>
      }
    >
      <label className="dc-field">
        <span>Title</span>
        <input
          autoFocus
          value={value}
          maxLength={200}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isImeKeyEvent(event)) submit();
          }}
        />
      </label>
    </Modal>
  );
}

export function DeleteDialog({
  entry,
  onClose,
  onConfirm,
}: {
  entry: DraftSummary;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="Delete this diagram?"
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" icon="trash" onClick={onConfirm}>
            Delete
          </Button>
        </>
      }
    >
      <p>
        <strong>{entry.title}</strong> will be removed from this browser. This cannot be undone.
      </p>
      <p className="dc-muted">
        If you might want it later, open it first and export a <code>.draftcanvas</code> file.
      </p>
    </Modal>
  );
}
