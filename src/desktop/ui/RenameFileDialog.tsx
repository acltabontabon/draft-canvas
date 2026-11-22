import { useEffect, useRef, useState } from 'react';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { Button } from '../../ui/common/Button';
import { Modal } from '../../ui/common/Modal';
import { DesktopError } from '../api';

/**
 * "Rename file…": a small, focused dialog for the one thing it does — changing a `.draftcanvas` file's
 * name in place. `onSubmit` is whichever of `DesktopController.renameOpenFile`/`renameFile` the caller
 * needs; this dialog doesn't know or care which file it's renaming, only its current name.
 */
export function RenameFileDialog({
  currentName,
  onSubmit,
  onClose,
}: {
  currentName: string;
  onSubmit: (newStem: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The editable stem starts selected, so typing a whole new name is one keystroke away — the
  // extension beside it is shown, never part of what's selected or typed.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  // A ref beside `busy`, as in `ExportDialog`: `busy` only lands on the next render, so a second
  // Enter in the same moment ran the rename again, on a file the first had already moved.
  const running = useRef(false);

  const submit = async () => {
    if (running.current) return;
    const stem = value.trim();
    if (!stem) {
      setError('Type a name for the file.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(stem);
      onClose();
    } catch (err) {
      setError(err instanceof DesktopError ? err.message : 'Draft Canvas couldn’t rename that file.');
      running.current = false;
      setBusy(false);
    }
  };

  const errorId = 'dc-rename-error';

  return (
    <Modal
      title="Rename File"
      // Not while the rename is under way: Escape closed the dialog, and a failure that came back
      // afterwards had nowhere to be shown.
      onClose={() => {
        if (!running.current) onClose();
      }}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="solid" icon="check" disabled={!value.trim() || busy} onClick={() => void submit()}>
            Rename
          </Button>
        </>
      }
    >
      <label className="dc-field">
        <span>File name</span>
        <span className="dc-rename-row">
          <input
            ref={inputRef}
            value={value}
            maxLength={200}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !isImeKeyEvent(event)) {
                // Consumed here, so a quick rename can't close the dialog and hand this same
                // keystroke on to whatever focus returned to (the tile's own Rename button).
                event.preventDefault();
                void submit();
              }
            }}
          />
          <span className="dc-rename-ext" aria-hidden="true">
            .draftcanvas
          </span>
        </span>
      </label>
      {error && (
        <p id={errorId} className="dc-export-note" data-invalid="true" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
