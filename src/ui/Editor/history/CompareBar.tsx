import { useState } from 'react';
import { ROOT_ROOM } from '../../../collab/changes';
import type { ElementChange } from '../../../evolution/diff';
import { endCompare, focusChange, setCompare, visibleChanges } from '../../../store/evolution/compare';
import { restoreElements } from '../../../store/evolution/operations';
import { reportOutcome as report } from '../../../commands/evolution';
import type { CompareState } from '../../../store/evolution/evolutionStore';
import { Button } from '../../common/Button';
import { SegmentedControl } from '../../common/SegmentedControl';

/**
 * The timeline's row while two versions are compared: what is compared, how it is shown, and the
 * changes — counted in one line, listed only when asked for. Choosing a change takes the camera
 * (and, if need be, the view) to it.
 */

const GLYPH = { added: '+', removed: '−', modified: '•' } as const;

function counts(changes: ElementChange[]): string {
  const added = changes.filter((change) => change.change === 'added').length;
  const removed = changes.filter((change) => change.change === 'removed').length;
  const changed = changes.length - added - removed;
  const parts = [added && `${added} added`, removed && `${removed} removed`, changed && `${changed} changed`].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No differences';
}

export function CompareBar({ compare }: { compare: CompareState }) {
  const [listing, setListing] = useState(false);
  const changes = visibleChanges(compare);
  // Comparing a revision with now: what it had can be brought back, one element at a time.
  const from = compare.target.oid === 'now' && compare.base.oid !== 'now' ? compare.base.oid : null;
  return (
    <div className="dc-compare-bar">
      <div className="dc-compare-bar-row">
        <span className="dc-compare-bar-what" title={`${compare.base.label} → ${compare.target.label}`}>
          <span className="dc-compare-bar-side">{compare.base.oid === 'now' ? 'Now' : compare.base.label}</span>
          <span aria-hidden="true">→</span>
          <span className="dc-compare-bar-side">{compare.target.oid === 'now' ? 'Now' : compare.target.label}</span>
        </span>
        <SegmentedControl
          name="compare-mode"
          legend="Show"
          value={compare.mode}
          options={[
            { value: 'overlay', label: 'Overlay' },
            { value: 'split', label: 'Side by side' },
          ]}
          onChange={(mode) => setCompare({ mode })}
        />
        {compare.mode === 'overlay' && (
          <SegmentedControl
            name="compare-side"
            legend="Version"
            value={compare.side}
            options={[
              { value: 'before', label: 'Before' },
              { value: 'after', label: 'After' },
            ]}
            onChange={(side) => setCompare({ side })}
          />
        )}
        <Button variant="quiet" aria-expanded={listing} onClick={() => setListing(!listing)}>
          {counts(changes)}
        </Button>
        <Button variant="quiet" icon="close" aria-label="Stop comparing" onClick={endCompare} />
      </div>
      {listing && (
        <div className="dc-compare-list-wrap">
          <label className="dc-timeline-chip" data-on={compare.structuralOnly ? 'true' : undefined}>
            <input type="checkbox" checked={compare.structuralOnly} onChange={(event) => setCompare({ structuralOnly: event.target.checked })} />
            Structure only
          </label>
          <ul className="dc-compare-list" aria-label="Changes">
            {changes.map((change) => (
              <li key={`${change.kind}:${change.id}`}>
                <button
                  type="button"
                  className="dc-compare-item"
                  data-change={change.change}
                  aria-current={compare.focused === `${change.kind}:${change.id}` ? 'true' : undefined}
                  onClick={() => focusChange(change)}
                >
                  <span className="dc-compare-item-glyph" aria-hidden="true">
                    {GLYPH[change.change]}
                  </span>
                  <span className="dc-compare-item-label">{change.label}</span>
                  <span className="dc-compare-item-what">
                    {change.change === 'modified' ? change.categories.join(', ') : change.change}
                    {change.room !== ROOT_ROOM && compare.diff.rooms[change.room] ? ` · in ${compare.diff.rooms[change.room]}` : ''}
                  </span>
                </button>
                {from && change.change !== 'added' && (
                  <Button variant="quiet" className="dc-compare-bring" onClick={() => void restoreElements(from, [change]).then(report)}>
                    Bring back
                  </Button>
                )}
              </li>
            ))}
            {changes.length === 0 && <li className="dc-timeline-empty">Nothing differs{compare.structuralOnly ? ' in structure' : ''}.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
