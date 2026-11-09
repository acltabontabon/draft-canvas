import { useId, useState, type KeyboardEvent } from 'react';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import type { ShareStart } from '../../share/link';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

export interface ShareChoice { key: string; label: string; start?: ShareStart }

export function ExportSharePanel({
  choices, choice, onChoice, protectedLink, onProtectedLink, passphrase, onPassphrase, confirmation, onConfirmation, busy, onSubmit,
}: {
  choices: ShareChoice[]; choice: string; onChoice: (key: string) => void;
  protectedLink: boolean; onProtectedLink: (value: boolean) => void;
  passphrase: string; onPassphrase: (value: string) => void;
  confirmation: string; onConfirmation: (value: string) => void; busy: boolean;
  /** Enter in a passphrase field: the dialog's own button, as every other passphrase prompt does. */
  onSubmit?: () => void;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || isImeKeyEvent(event)) return;
    event.preventDefault();
    onSubmit?.();
  };
  // Every level travels in the link, and anyone who opens it can keep what they see: the short line
  // under the fields says the first, the switch's tooltip the rest.
  const caution = protectedLink
    ? 'Every level is included. Whoever unlocks it can save or capture it.'
    : 'Every level is included. Anyone with the link can read, save or capture it.';
  return (
    <div className="dc-export-panel dc-share-panel">
      <div className="dc-export-form">
        <label className="dc-export-label" htmlFor={`${id}-start`}>Start at</label>
        <span className="dc-share-start-select">
          <select id={`${id}-start`} value={choice} onChange={(event) => onChoice(event.target.value)} disabled={busy}>{choices.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select>
          <Icon name="down" size={14} />
        </span>

        <span className="dc-export-label" aria-hidden="true">Protect</span>
        <label className="dc-check" title={caution}>
          <input type="checkbox" checked={protectedLink} disabled={busy} onChange={(event) => onProtectedLink(event.target.checked)} />
          <span>Require a passphrase</span>
        </label>

        {protectedLink && <>
          <label className="dc-export-label" htmlFor={`${id}-passphrase`}>Passphrase</label>
          <div className="dc-share-password"><input id={`${id}-passphrase`} type={show ? 'text' : 'password'} autoComplete="new-password" disabled={busy} value={passphrase} aria-invalid={tooShort} aria-describedby={`${id}-hint`} onChange={(event) => onPassphrase(event.target.value)} onKeyDown={submitOnEnter} /><Button variant="quiet" aria-pressed={show} onClick={() => setShow(!show)} disabled={busy}>{show ? 'Hide' : 'Show'}</Button></div>

          <label className="dc-export-label" htmlFor={`${id}-confirm`}>Confirm</label>
          <div className="dc-share-password"><input id={`${id}-confirm`} aria-label="Confirm passphrase" type={show ? 'text' : 'password'} autoComplete="new-password" value={confirmation} disabled={busy} aria-invalid={mismatch} onChange={(event) => onConfirmation(event.target.value)} onKeyDown={submitOnEnter} /></div>
        </>}

        <span aria-hidden="true" />
        <div className="dc-share-hints">
          {protectedLink && (tooShort || mismatch) && <p className="dc-export-note" data-invalid="true" role="status">{tooShort ? 'Use at least 8 characters.' : 'Passphrases don’t match.'}</p>}
          {protectedLink && <p className="dc-export-hint" id={`${id}-hint`}>At least 8 characters. Send it separately; it can’t be recovered.</p>}
          {/* Kept on the panel, not only in a tooltip: a level you're not looking at still travels. */}
          <p className="dc-export-hint">{protectedLink ? 'Includes every level.' : 'Anyone with the link can read every level.'}</p>
        </div>
      </div>
    </div>
  );
}
