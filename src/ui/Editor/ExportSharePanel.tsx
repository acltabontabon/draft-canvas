import { useId, useState } from 'react';
import type { ShareStart } from '../../share/link';
import { Button } from '../common/Button';

export interface ShareChoice { key: string; label: string; start?: ShareStart }

export function ExportSharePanel({
  choices, choice, onChoice, protectedLink, onProtectedLink, passphrase, onPassphrase, confirmation, onConfirmation, busy,
}: {
  choices: ShareChoice[]; choice: string; onChoice: (key: string) => void;
  protectedLink: boolean; onProtectedLink: (value: boolean) => void;
  passphrase: string; onPassphrase: (value: string) => void;
  confirmation: string; onConfirmation: (value: string) => void; busy: boolean;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  return (
    <div className="dc-export-panel dc-share-panel">
      <h3>A link made for reading</h3>
      <p className="dc-export-panel-description">Send a snapshot that opens in any browser.</p>
      <label className="dc-field"><span>Start at</span><select value={choice} onChange={(event) => onChoice(event.target.value)} disabled={busy}>{choices.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
      <label className="dc-share-protection"><span><strong>Require a passphrase</strong><small>Protect the diagram before sharing it.</small></span><input type="checkbox" checked={protectedLink} disabled={busy} onChange={(event) => onProtectedLink(event.target.checked)} /></label>
      {protectedLink && <>
        <label className="dc-field" htmlFor={`${id}-passphrase`}>Passphrase</label>
        <div className="dc-share-password"><input id={`${id}-passphrase`} type={show ? 'text' : 'password'} autoComplete="new-password" disabled={busy} value={passphrase} aria-invalid={tooShort} aria-describedby={`${id}-hint`} onChange={(event) => onPassphrase(event.target.value)} /><Button variant="quiet" aria-pressed={show} onClick={() => setShow(!show)} disabled={busy}>{show ? 'Hide' : 'Show'}</Button></div>
        <label className="dc-field"><span>Confirm passphrase</span><input type={show ? 'text' : 'password'} autoComplete="new-password" value={confirmation} disabled={busy} aria-invalid={mismatch} onChange={(event) => onConfirmation(event.target.value)} /></label>
        {(tooShort || mismatch) && <p className="dc-export-note" data-invalid="true" role="status">{tooShort ? 'Use at least 8 characters.' : 'Passphrases don’t match.'}</p>}
        <p className="dc-share-hint" id={`${id}-hint`}>Use at least 8 characters; a long, unique phrase is safer. Send it separately. It cannot be recovered if lost.</p>
      </>}
      <p className="dc-share-hint">Every level is included. {protectedLink ? 'Unlocked content' : 'Anyone with the link can read the diagram. Its content'} can be saved or captured.</p>
    </div>
  );
}
