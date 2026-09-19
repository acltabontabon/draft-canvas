import { useId, useState } from 'react';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

const MIN_LENGTH = 8;

/**
 * Passphrase entered twice, confirmed match required before the export
 * button is enabled — the usual "don't let a typo lock you out of your own
 * file" discipline for a secret with no recovery path.
 */
export function SecureExportPrompt({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (passphrase: string) => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const ruleId = useId();
  const mismatchId = useId();

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_LENGTH;
  const mismatch = confirmPassphrase.length > 0 && passphrase !== confirmPassphrase;
  const canExport = passphrase.length >= MIN_LENGTH && passphrase === confirmPassphrase;
  const confirm = () => {
    if (canExport && !busy) onConfirm(passphrase);
  };

  return (
    <Modal
      title="Export securely"
      width={420}
      // Inert while encrypting: the file still downloads, so closing now would only hide it.
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="solid" icon="export" disabled={!canExport || busy} onClick={confirm}>
            {busy ? 'Encrypting…' : 'Export securely'}
          </Button>
        </>
      }
    >
      <p className="dc-muted">
        Anyone who wants to open this file will need this passphrase. Draft Canvas does not store
        it and cannot recover it — if it's lost, the file is unreadable.
      </p>
      <label className="dc-field">
        <span>Passphrase</span>
        <input
          autoFocus
          type="password"
          autoComplete="new-password"
          value={passphrase}
          aria-describedby={ruleId}
          aria-invalid={tooShort || undefined}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </label>
      {/* Said up front, so a disabled button is never a mystery. */}
      <p id={ruleId} className="dc-export-note" data-invalid={tooShort || undefined}>
        At least {MIN_LENGTH} characters.
      </p>
      <label className="dc-field">
        <span>Confirm passphrase</span>
        <input
          type="password"
          autoComplete="new-password"
          value={confirmPassphrase}
          aria-describedby={mismatch ? mismatchId : undefined}
          aria-invalid={mismatch || undefined}
          onChange={(event) => setConfirmPassphrase(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && !isImeKeyEvent(event)) confirm();
          }}
        />
      </label>
      {mismatch && (
        <p id={mismatchId} className="dc-export-note" data-invalid="true">
          Passphrases don't match.
        </p>
      )}
    </Modal>
  );
}
