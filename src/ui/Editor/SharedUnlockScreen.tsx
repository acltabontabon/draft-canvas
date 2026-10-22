import { useEffect, useRef, useState } from 'react';
import type { DocumentSession } from '../../store/useDocumentSession';
import { PRODUCT } from '../../product';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

export function SharedUnlockScreen({ link, ready }: { link: NonNullable<DocumentSession['sharedLink']>; ready: boolean }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    document.title = `Protected diagram — ${PRODUCT.name}`;
    mounted.current = true;
    return () => { mounted.current = false; document.title = PRODUCT.name; };
  }, []);
  const unlock = async () => {
    if (running.current || !passphrase) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const message = await link.unlock(passphrase);
      if (mounted.current) setError(message);
    } catch {
      if (mounted.current) setError('This diagram could not be unlocked. Try again.');
    } finally {
      if (mounted.current) { setPassphrase(''); setBusy(false); }
      running.current = false;
    }
  };
  return (
    <main className="dc-share-unlock">
      <header className="dc-reader-header"><span className="dc-reader-brand"><Icon name="layers" size={18} />{PRODUCT.name}</span><span className="dc-reader-muted">Protected diagram</span></header>
      <div className="dc-share-unlock-body"><form className="dc-share-unlock-form" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
        <div className="dc-share-unlock-heading"><span className="dc-share-unlock-icon"><Icon name="lock" size={19} /></span><h1>Shared with you</h1></div>
        <p>Enter the sender’s passphrase to view this diagram.</p>
        <label className="dc-field"><span>Passphrase</span><input autoFocus type="password" autoComplete="off" value={passphrase} disabled={busy || !ready} aria-invalid={Boolean(error)} aria-describedby={error ? 'share-unlock-error' : undefined} onChange={(event) => setPassphrase(event.target.value)} /></label>
        {error && <p id="share-unlock-error" className="dc-share-error" role="alert">{error}</p>}
        <Button type="submit" variant="solid" disabled={!passphrase || busy || !ready} aria-busy={busy || !ready}>{busy ? 'Unlocking…' : 'Unlock diagram'}</Button>
        <p className="dc-share-unlock-note">Decrypted here. Your passphrase is never saved.</p>
      </form></div>
    </main>
  );
}
