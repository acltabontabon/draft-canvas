import type { ShareStage } from '../../share/compress';
import { Button } from '../common/Button';

const LABELS: Record<ShareStage, string> = {
  preparing: 'Preparing the diagram…',
  compressing: 'Compressing the link…',
  protecting: 'Protecting with your passphrase…',
  copying: 'Copying the link…',
};

export function ExportShareProgress({ stage, onCancel }: { stage: ShareStage; onCancel: () => void }) {
  return (
    <section className="dc-share-progress" aria-label="Link preparation">
      <h3>Making your link</h3>
      <p role="status">{LABELS[stage]}</p>
      <div className="dc-share-progress-track" role="progressbar" aria-label="Preparing share link" aria-valuetext={LABELS[stage]}><span /></div>
      <p className="dc-share-hint">Everything stays on this device.</p>
      {stage !== 'copying' && <Button variant="quiet" onClick={onCancel}>Cancel</Button>}
    </section>
  );
}
