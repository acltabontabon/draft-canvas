import { useState } from 'react';
import type { Revision } from '../../../evolution/timeline';
import { Button } from '../../common/Button';

/**
 * What can be done with the revision on screen. The everyday actions first; Git's own details —
 * the commit id, its parents, who recorded it — behind "Details", for the people who want them.
 */
export function RevisionActions({ revision }: { revision: Revision }) {
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="dc-timeline-actions">
      <Button variant="quiet" aria-expanded={details} onClick={() => setDetails(!details)}>
        Details
      </Button>
      {details && (
        <dl className="dc-timeline-git">
          <dt>Revision</dt>
          <dd>
            <code>{revision.oid}</code>{' '}
            <Button
              variant="quiet"
              onClick={() => {
                void navigator.clipboard?.writeText(revision.oid).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </dd>
          <dt>Follows</dt>
          <dd>{revision.parents.length === 0 ? 'Start of history' : revision.parents.map((parent) => <code key={parent}>{parent.slice(0, 12)} </code>)}</dd>
          <dt>Recorded by</dt>
          <dd>{revision.recordedBy}</dd>
          {revision.categories.length > 0 && (
            <>
              <dt>Changed</dt>
              <dd>{revision.categories.join(', ')}</dd>
            </>
          )}
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
    </div>
  );
}
