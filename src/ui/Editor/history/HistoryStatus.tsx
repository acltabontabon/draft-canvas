import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  acknowledgeHistoryNote,
  answerHistoryIdentity,
  captureRevisionNow,
  openHistorySettings,
  setHistoryDetailsOpen,
  setTimelineOpen,
} from '../../../commands/evolution';
import { isImeKeyEvent, overlayAboveCanvasIsOpen } from '../../../lib/isEditableTarget';
import { relativeTime } from '../../../lib/relativeTime';
import { useEvolutionStore, type CaptureState, type RemoteState } from '../../../store/evolution/evolutionStore';
import { Button } from '../../common/Button';
import { Icon } from '../../common/Icon';
import { Tooltip } from '../../common/Tooltip';
import { resolveUnfinished } from '../../../store/evolution/operations';
import { addMilestone } from '../../../store/evolution/historyView';
import { reportOutcome as report } from '../../../commands/evolution';
import { HistorySettingsDialog } from './HistorySettingsDialog';
import './history.css';

/**
 * Canvas Evolution's one line in the status bar, right after the save label it extends: a quiet
 * glyph while history is simply being kept, words only when something wants the person — a
 * question, a pause, a failure. No toast for a revision, ever.
 *
 * Saving, capturing and publishing stay three different facts. The save label says the first;
 * this says the second; the popover lists all three without ever calling a local capture "synced".
 */

type Tone = 'quiet' | 'pending' | 'attention' | 'danger';

function summary(capture: CaptureState): { label: string | null; tone: Tone; describe: string } {
  switch (capture.kind) {
    case 'off':
      return { label: null, tone: 'quiet', describe: capture.reason === 'diagram' ? 'History is paused for this diagram.' : 'History is off.' };
    case 'unavailable':
      return { label: 'History unavailable', tone: 'attention', describe: capture.message };
    case 'elsewhere':
      return { label: null, tone: 'quiet', describe: 'Another tab is keeping this diagram’s history. It shows here read-only.' };
    case 'identity':
      return {
        label: 'Continue history?',
        tone: 'attention',
        describe: capture.relation === 'moved' ? `This looks like “${capture.title}”, moved.` : `This looks like a copy of “${capture.title}”.`,
      };
    case 'empty':
      return { label: null, tone: 'quiet', describe: 'No history yet. The next change starts it.' };
    case 'up-to-date':
      return { label: null, tone: 'quiet', describe: 'Every change is in this diagram’s history.' };
    case 'pending':
      return { label: null, tone: 'pending', describe: 'Recent changes will be added to history in a moment.' };
    case 'capturing':
      return { label: null, tone: 'pending', describe: 'Adding recent changes to history…' };
    case 'failed':
      return {
        label: capture.quota ? 'History paused: storage full' : 'History paused',
        tone: 'danger',
        describe: `${capture.message} Your diagram is still saved; only its history is waiting.`,
      };
  }
}

function remoteLine(remote: RemoteState): string | null {
  switch (remote.kind) {
    case 'none':
      return null;
    case 'not-published':
      return remote.ahead > 0 ? `Not published · ${remote.ahead} revision${remote.ahead === 1 ? '' : 's'} only on this device` : 'Published copy is current';
    case 'publishing':
      return 'Publishing…';
    case 'published':
      return 'Published copy is current';
    case 'incoming':
      return `${remote.behind} revision${remote.behind === 1 ? '' : 's'} available from the remote`;
    case 'diverged':
      return 'This device and the remote have both changed';
    case 'offline':
      return 'Remote unreachable · history is kept here meanwhile';
    case 'failed':
      return remote.message;
  }
}

export function HistoryStatus() {
  const { capture, remote, tipAt, revisions, altName, firstUse, open, repoId, unfinished, suggestion } = useEvolutionStore(
    useShallow((state) => ({
      unfinished: state.unfinished,
      suggestion: state.milestoneSuggestion,
      capture: state.capture,
      remote: state.remote,
      tipAt: state.tipAt,
      revisions: state.revisions,
      altName: state.altName,
      firstUse: state.firstUse,
      open: state.detailsOpen,
      repoId: state.repoId,
    })),
  );
  const ref = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyEvent(event)) return;
      // A menu or dialog stacked above this closes first, on its own Escape.
      if (overlayAboveCanvasIsOpen()) return;
      // Claimed in the capture phase, as every canvas popover claims it: heard in the bubble phase
      // and left to go on, the same press also reached the editor's own Escape, which cleared the
      // selection — or, with nothing selected inside a shape, backed out of it.
      event.stopPropagation();
      setHistoryDetailsOpen(false);
      ref.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !ref.current?.contains(target)) setHistoryDetailsOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open]);

  if (capture.kind === 'off' && capture.reason !== 'diagram') return <HistorySettingsDialog />;
  const { label, tone, describe } = summary(capture);
  const when = tipAt ? `Last added ${relativeTime(tipAt)}` : null;
  const remoteText = remoteLine(remote);
  const announce = tone === 'danger' || tone === 'attention' ? (label ?? '') : '';

  return (
    <span className="dc-history-status" data-tone={tone} data-capture={capture.kind}>
      <Tooltip content={{ title: label ?? 'History', description: describe }}>
        {(tip) => (
          <button
            ref={ref}
            type="button"
            className="dc-history-chip"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`History: ${label ?? describe}`}
            onClick={() => setHistoryDetailsOpen(!open)}
            {...tip}
          >
            <Icon name="timeline" size={14} />
            {label && <span className="dc-history-chip-label">{label}</span>}
            {(firstUse || unfinished || suggestion || tone === 'pending') && !label && <span className="dc-history-chip-dot" data-attention={unfinished || suggestion ? 'true' : undefined} aria-hidden="true" />}
          </button>
        )}
      </Tooltip>
      <span className="dc-sr-only" role="status">
        {announce}
      </span>
      {open && (
        // Its buttons own the bare keys while focus is in it (`data-dc-keyboard-region`): Delete on
        // "Got it" deleted the canvas selection behind the popover, and a letter dropped a shape.
        <div ref={panel} className="dc-history-details" role="dialog" aria-label="History" data-dc-keyboard-region="">
          <div className="dc-history-details-title">
            <Icon name="timeline" size={15} />
            History{altName ? <span className="dc-history-details-alt"> · {altName}</span> : null}
          </div>
          <p className="dc-history-details-line">{describe}</p>
          {(when || revisions > 0) && <p className="dc-history-details-meta">{[when, revisions > 0 ? `${revisions} new this session` : null].filter(Boolean).join(' · ')}</p>}
          {remoteText && <p className="dc-history-details-meta">{remoteText}</p>}
          {capture.kind === 'identity' && (
            <div className="dc-history-details-actions">
              <Button variant="solid" onClick={() => answerHistoryIdentity(true)}>
                Continue its history
              </Button>
              <Button variant="quiet" onClick={() => answerHistoryIdentity(false)}>
                Start new history
              </Button>
            </div>
          )}
          {suggestion && (
            <div className="dc-history-note" role="group" aria-label="Suggested milestone">
              <p>An agent suggests naming a revision “{suggestion.name}”.</p>
              <Button
                variant="solid"
                onClick={() => {
                  useEvolutionStore.setState({ milestoneSuggestion: null });
                  void addMilestone(suggestion.revision, suggestion.name).catch(() => undefined);
                }}
              >
                Name it
              </Button>
              <Button variant="quiet" onClick={() => useEvolutionStore.setState({ milestoneSuggestion: null })}>
                Dismiss
              </Button>
            </div>
          )}
          {unfinished && (
            <div className="dc-history-note" role="group" aria-label="Unfinished">
              <p>{unfinished.reason}</p>
              <Button variant="solid" onClick={() => void resolveUnfinished(true).then(report)}>
                {unfinished.kind === 'switch' ? 'Finish switching' : unfinished.kind === 'merge' ? 'Finish merging' : unfinished.kind === 'fast-forward' ? 'Finish bringing it in' : 'Finish restoring'}
              </Button>
              <Button variant="quiet" onClick={() => void resolveUnfinished(false).then(report)}>
                Keep the diagram as it is
              </Button>
            </div>
          )}
          {firstUse && (
            <div className="dc-history-note">
              <p>
                History keeps earlier versions of this diagram on this device — including things you later delete. You can pause it, export it or remove it
                in Settings → History.
              </p>
              <Button variant="quiet" onClick={acknowledgeHistoryNote}>
                Got it
              </Button>
            </div>
          )}
          <div className="dc-history-details-actions">
            {repoId && (
              <Button variant="quiet" icon="timeline" onClick={() => setTimelineOpen(true)}>
                Open timeline
              </Button>
            )}
            {(capture.kind === 'pending' || capture.kind === 'failed') && (
              <Button variant="quiet" onClick={captureRevisionNow}>
                {capture.kind === 'failed' ? 'Try again' : 'Add to history now'}
              </Button>
            )}
            <Button variant="quiet" onClick={() => openHistorySettings(true)}>
              History settings…
            </Button>
          </div>
        </div>
      )}
      <HistorySettingsDialog />
    </span>
  );
}
