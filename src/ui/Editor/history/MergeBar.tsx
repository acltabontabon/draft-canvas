import { useState } from 'react';
import { reportOutcome } from '../../../commands/evolution';
import type { Conflict } from '../../../evolution/merge';
import { focusChange } from '../../../store/evolution/compare';
import type { MergeSession } from '../../../store/evolution/evolutionStore';
import { cancelMerge, chooseConflict, finishMerge, mergeReady } from '../../../store/evolution/merging';
import { Button } from '../../common/Button';
import { SegmentedControl } from '../../common/SegmentedControl';

/**
 * The timeline's line while a merge is reviewed: what comes into what, how much combined on its
 * own, and each difference that needs a choice — in plain words, with the canvas showing the
 * result as it stands. Merge stays off until every difference is decided; Cancel leaves both as
 * they were.
 */
export function MergeBar({ session }: { session: MergeSession }) {
  const [busy, setBusy] = useState(false);
  const conflicts = session.result.conflicts;
  const open = conflicts.filter((conflict) => session.choices[conflict.id] === undefined).length;
  const into = session.into.name === 'Main architecture' ? 'the main architecture' : `“${session.into.name}”`;
  return (
    <div className="dc-compare-bar dc-merge-bar">
      <div className="dc-compare-bar-row">
        <span className="dc-compare-bar-what">
          Bringing “{session.source.name}” into {into}
          <span className="dc-timeline-detail-meta">
            {session.result.combined} combined{conflicts.length > 0 ? ` · ${open === 0 ? 'all decided' : `${open} to decide`}` : ''}
          </span>
        </span>
        <Button variant="quiet" onClick={() => void cancelMerge()}>
          Cancel
        </Button>
        <Button
          variant="solid"
          disabled={busy || !mergeReady(session)}
          onClick={() => {
            setBusy(true);
            void finishMerge().then((outcome) => {
              setBusy(false);
              reportOutcome(outcome);
            });
          }}
        >
          Merge
        </Button>
      </div>
      {conflicts.length > 0 && (
        <ul className="dc-compare-list dc-merge-list" aria-label="Differences to decide">
          {conflicts.map((conflict) => (
            <ConflictRow key={conflict.id} conflict={conflict} session={session} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConflictRow({ conflict, session }: { conflict: Conflict; session: MergeSession }) {
  const [kind, id] = conflict.key.split(':');
  const choice = session.choices[conflict.id];
  return (
    <li className="dc-merge-row" data-decided={choice ? 'true' : undefined}>
      <button
        type="button"
        className="dc-compare-item"
        data-change="modified"
        onClick={() => {
          if ((kind === 'node' || kind === 'edge') && id) {
            focusChange({ kind, id, room: '', change: 'modified', label: conflict.label, categories: [], fields: [] });
          }
        }}
      >
        <span className="dc-compare-item-glyph" aria-hidden="true">
          ?
        </span>
        <span className="dc-compare-item-label">{conflict.label}</span>
        <span className="dc-compare-item-what">{conflict.description}</span>
      </button>
      {conflict.ours === null && conflict.theirs === null ? (
        <Button variant={choice ? 'quiet' : 'solid'} aria-pressed={choice !== undefined} onClick={() => void chooseConflict(conflict.id, 'ours')}>
          {choice ? 'Accepted' : 'Accept as combined'}
        </Button>
      ) : (
      <SegmentedControl
        name={`merge-${conflict.id}`}
        legend={`Keep for ${conflict.label}`}
        value={choice ?? ('' as never)}
        options={[
          { value: 'ours', label: 'Keep this' },
          { value: 'theirs', label: `Take “${session.source.name}”` },
        ]}
        onChange={(side) => void chooseConflict(conflict.id, side)}
      />
      )}
    </li>
  );
}
