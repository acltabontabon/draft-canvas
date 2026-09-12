import { useState } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

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

  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const mismatch = confirmPassphrase.length > 0 && passphrase !== confirmPassphrase;
  const canExport = passphrase.length >= 8 && passphrase === confirmPassphrase;

  return (
    <Modal
      title="Export securely"
      width={420}
      onClose={onCancel}
      footer={
        <>
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="solid"
            icon="export"
            disabled={!canExport || busy}
            onClick={() => onConfirm(passphrase)}
          >
            Export securely
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
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </label>
      {tooShort && <p className="dc-muted dc-export-note">At least 8 characters.</p>}
      <label className="dc-field">
        <span>Confirm passphrase</span>
        <input
          type="password"
          value={confirmPassphrase}
          onChange={(event) => setConfirmPassphrase(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && canExport) onConfirm(passphrase);
          }}
        />
      </label>
      {mismatch && <p className="dc-muted dc-export-note">Passphrases don't match.</p>}
    </Modal>
  );
}
