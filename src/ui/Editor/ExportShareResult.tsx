import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

export function ExportShareResult({ url, protectedLink, copyFailed, busy, onEdit }: {
  url: string; protectedLink: boolean; copyFailed: boolean; busy: boolean; onEdit: () => void;
}) {
  return (
    <section className="dc-share-result" aria-label="Generated share link">
      <h3>{protectedLink ? 'Protected link ready' : 'Share link ready'}</h3>
      <p>{protectedLink ? 'Send the passphrase separately. The recipient unlocks the diagram on their device.' : 'Anyone with this link can read the diagram.'}</p>
      {copyFailed && <p className="dc-share-copy-error" role="status">The clipboard is unavailable. Select and copy the link below, or open the reader.</p>}
      <label className="dc-field"><span>Share link</span><input type="url" readOnly value={url} onFocus={(event) => event.currentTarget.select()} /></label>
      <p className="dc-share-link-size">{url.length.toLocaleString()} characters · self-contained link</p>
      <div className="dc-share-result-actions">
        <a className="dc-button dc-button-ghost" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" />Open Guided reader</a>
        <Button variant="quiet" disabled={busy} onClick={onEdit}>Edit share settings</Button>
      </div>
    </section>
  );
}
