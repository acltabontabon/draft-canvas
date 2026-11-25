import { useState } from 'react';
import type { Revision } from '../../../evolution/timeline';
import { compareVersions } from '../../../store/evolution/compare';
import { addMilestone } from '../../../store/evolution/historyView';
import { useUiStore } from '../../../store/uiStore';
import { Button } from '../../common/Button';
import { MenuButton } from './MenuButton';

/**
 * What can be done with the revision on screen: at most a couple of visible actions, and the
 * occasional ones — naming it, its Git details — behind one "More" menu.
 */
export function RevisionActions({ revision }: { revision: Revision }) {
  const [naming, setNaming] = useState(false);
  const [details, setDetails] = useState(false);

  const more = () => [
    ...(revision.parents[0] ? [{ id: 'previous', label: 'Compare with the revision before', onSelect: () => void compareVersions(revision.parents[0]!, revision.oid) }] : []),
    { id: 'name', label: revision.milestones.length > 0 ? 'Add another name…' : 'Name this revision…', onSelect: () => setNaming(true) },
    {
      id: 'copy',
      label: 'Copy revision id',
      onSelect: () => {
        void navigator.clipboard?.writeText(revision.oid).then(() => useUiStore.getState().notify('Revision id copied.'));
      },
    },
    { id: 'details', label: details ? 'Hide Git details' : 'Show Git details', onSelect: () => setDetails(!details) },
  ];

  return (
    <>
      <div className="dc-timeline-actions">
        <Button variant="quiet" onClick={() => void compareVersions(revision.oid, 'now')}>
          Compare with now
        </Button>
        <MenuButton icon="more" label="More for this revision" items={more} />
      </div>
      {naming && <MilestoneForm oid={revision.oid} onDone={() => setNaming(false)} />}
      {details && (
        <dl className="dc-timeline-git">
          <dt>Revision</dt>
          <dd>
            <code>{revision.oid}</code>
          </dd>
          <dt>Follows</dt>
          <dd>{revision.parents.length === 0 ? 'Start of history' : revision.parents.map((parent) => <code key={parent}>{parent.slice(0, 12)} </code>)}</dd>
          <dt>Recorded by</dt>
          <dd>{revision.recordedBy}</dd>
          {revision.body.length > 0 && (
            <>
              <dt>Changes</dt>
              <dd>
                <ul>
                  {revision.body.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

function MilestoneForm({ oid, onDone }: { oid: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="dc-timeline-milestone-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        addMilestone(oid, name).then(onDone, (failure: unknown) => setError(failure instanceof Error ? failure.message : 'The name could not be saved.'));
      }}
    >
      <span className="dc-field">
        <input
          autoFocus
          maxLength={120}
          placeholder="Name, e.g. “Reviewed with security”"
          aria-label="Revision name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onDone();
            }
          }}
        />
      </span>
      <Button type="submit" variant="solid" disabled={!name.trim()}>
        Save
      </Button>
      <Button variant="quiet" onClick={onDone}>
        Cancel
      </Button>
      {error && (
        <span className="dc-timeline-detail-meta" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
