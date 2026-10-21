import { useEffect, useState } from 'react';
import { readPreference, writePreference } from '../../lib/preferences';
import { count } from '../../lib/plural';
import { relativeTime } from '../../lib/relativeTime';
import { PRODUCT } from '../../product';
import type { DraftRepository } from '../../storage';
import { MOVED_DIAGRAMS_PREFERENCE, sendDiagrams, type SendOutcome } from '../../storage/handoff';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { backUpLibrary } from './backupActions';
import './moved-house.css';

const NEW_HOME = new URL(PRODUCT.web.app).host;

type State =
  | { kind: 'idle' }
  | { kind: 'moving' }
  | { kind: 'moved'; restored: number; renamed: number; skipped: number; unreadable: number }
  | { kind: 'problem'; message: string };

/**
 * The move in flight, outside any one mount: Home and the gallery each render this notice, and
 * switching between them mid-move must neither forget it nor offer to start a second one.
 */
let inflight: Promise<SendOutcome> | null = null;

function stateOf(outcome: SendOutcome): State {
  switch (outcome.kind) {
    case 'moved':
      return outcome.restored > 0
        ? { kind: 'moved', restored: outcome.restored, renamed: outcome.renamed, skipped: outcome.skipped, unreadable: outcome.unreadable }
        : { kind: 'problem', message: `Nothing arrived at ${NEW_HOME} — your diagrams couldn’t be read there. Use the backup route below.` };
    case 'blocked':
      return { kind: 'problem', message: 'Your browser blocked the new tab. Allow pop-ups for this site, then try again.' };
    case 'closed':
      return { kind: 'problem', message: 'The new tab closed before your diagrams arrived. Try again and leave it open for a moment.' };
    case 'timeout':
      return {
        kind: 'problem',
        message: outcome.stage === 'ready'
          ? `${NEW_HOME} didn’t answer. Check that it opened, then try again.`
          : 'The move didn’t finish in time. Try again, or use the backup route below.',
      };
    case 'failed':
      return { kind: 'problem', message: `The move didn’t work: ${outcome.message}` };
  }
}

/**
 * The editor's old address, telling people where Draft Canvas lives now — and, since their diagrams
 * can't follow on their own (storage is per origin), carrying them over in one click. They travel
 * tab to tab (`storage/handoff.ts`); nothing is uploaded. The manual route stays one line away.
 */
export function MovedHouseNotice({ repository, hasDocuments }: { repository: DraftRepository; hasDocuments: boolean }) {
  const notify = useUiStore((state) => state.notify);
  const [state, setState] = useState<State>(() => (inflight ? { kind: 'moving' } : { kind: 'idle' }));
  const [movedAt, setMovedAt] = useState(() => readPreference(MOVED_DIAGRAMS_PREFERENCE));

  const follow = (move: Promise<SendOutcome>) => {
    void move.then((outcome) => {
      setState(stateOf(outcome));
      setMovedAt(readPreference(MOVED_DIAGRAMS_PREFERENCE));
    });
  };

  // Mounted while a move started elsewhere is still going: show it, and its outcome.
  useEffect(() => {
    const move = inflight;
    if (!move) return;
    let current = true;
    void move.then((outcome) => {
      if (!current) return;
      setState(stateOf(outcome));
      setMovedAt(readPreference(MOVED_DIAGRAMS_PREFERENCE));
    });
    return () => {
      current = false;
    };
  }, []);

  const bring = () => {
    if (inflight) return;
    // Straight from the click, so the new tab opens before anything is awaited.
    const move = sendDiagrams({ repository }).then((outcome) => {
      if (outcome.kind === 'moved' && outcome.restored > 0) writePreference(MOVED_DIAGRAMS_PREFERENCE, new Date().toISOString());
      return outcome;
    });
    inflight = move;
    void move.finally(() => {
      if (inflight === move) inflight = null;
    });
    setState({ kind: 'moving' });
    follow(move);
  };

  const openLink = (
    <a className="dc-moved-link" href={PRODUCT.web.app} target="_blank" rel="noopener noreferrer">
      Open {NEW_HOME}
    </a>
  );

  if (!hasDocuments && state.kind === 'idle') {
    return (
      <section className="dc-moved" aria-labelledby="dc-moved-title">
        <h2 id="dc-moved-title" className="dc-moved-title">Draft Canvas has moved house</h2>
        <p className="dc-moved-body">Its new address is {NEW_HOME}. Start your next diagram there.</p>
        <div className="dc-moved-actions">{openLink}</div>
      </section>
    );
  }

  const movedBefore = state.kind === 'idle' && movedAt !== null && !Number.isNaN(Date.parse(movedAt));
  const moving = state.kind === 'moving';

  return (
    <section className="dc-moved" aria-labelledby="dc-moved-title" aria-busy={moving || undefined}>
      <h2 id="dc-moved-title" className="dc-moved-title">Draft Canvas has moved house</h2>
      <div role="status" className="dc-moved-status">
        {state.kind === 'moved' ? (
          <p className="dc-moved-body">
            Moved {count(state.restored, 'diagram')} to {NEW_HOME}.
            {state.renamed > 0 && ` ${state.renamed === 1 ? 'One was' : `${state.renamed} were`} already there and arrived as ${state.renamed === 1 ? 'a copy' : 'copies'}.`}
            {state.unreadable > 0 && ` ${count(state.unreadable, 'diagram')} couldn’t be read here.`}
            {state.skipped > 0 && ` ${count(state.skipped, 'file')} couldn’t be read there.`}
          </p>
        ) : movedBefore ? (
          <p className="dc-moved-body">Your diagrams went to {NEW_HOME} {relativeTime(Date.parse(movedAt))}. They’re still here too.</p>
        ) : state.kind === 'problem' ? (
          <p className="dc-moved-body dc-moved-problem">{state.message}</p>
        ) : (
          <p className="dc-moved-body">
            Your diagrams are still here. Bring them to {NEW_HOME} — they travel straight from this tab to
            the new one; nothing is uploaded.
          </p>
        )}
      </div>

      <div className="dc-moved-actions">
        {state.kind === 'moved' || movedBefore ? (
          <>
            {openLink}
            <button type="button" className="dc-moved-again" onClick={bring}>
              Send them again
            </button>
            <span className="dc-moved-aside">Anything already there arrives as a copy.</span>
          </>
        ) : (
          <>
            <Button variant="solid" icon="forward" disabled={moving} onClick={bring}>
              {moving ? 'Moving…' : state.kind === 'problem' ? 'Try again' : 'Bring my diagrams'}
            </Button>
            {moving && <span className="dc-moved-aside">Keep both tabs open for a moment.</span>}
          </>
        )}
      </div>

      {state.kind !== 'moved' && !movedBefore && (
        <p className="dc-moved-fallback">
          Or by hand:{' '}
          <button type="button" className="dc-moved-again" onClick={() => void backUpLibrary(repository, notify)}>
            Back up here
          </button>
          , then choose Restore at{' '}
          <a href={PRODUCT.web.app} target="_blank" rel="noopener noreferrer">
            {NEW_HOME}
          </a>
          .
        </p>
      )}
    </section>
  );
}
