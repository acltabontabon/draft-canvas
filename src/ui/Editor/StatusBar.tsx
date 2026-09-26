import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { fileOf, flowFitViewNodes, useEditorStore, viewLevel } from '../../store/editorStore';
import { isEmpty, openCount, takeawaysFor } from '../../takeaways/collect';
import { count } from '../../lib/plural';
import { LEVEL_HINTS, LEVEL_LABELS } from '../../depth/level';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { motionMs } from '../../lib/motion';
import { RECALL_FLOOR_MS, RECALL_MS } from '../../takeaways/recall';
import { usePopoverPresence } from '../../canvas/usePopoverPresence';
import { DesktopStatus } from '../../desktop/ui/DesktopStatus';
import { embeddedHost } from '../../host/embeddedHost';
import { hostKind } from '../../host/hostInfo';
import { useUiStore } from '../../store/uiStore';
import { pointsOf, unresolvedOpenPoints } from '../../document/openPoints';

/** The nudge leaves by folding down into the chip, which wants a beat longer than a fade. */
const NUDGE_EXIT_MS = 200;

/**
 * The save indicator is the only place the local-first promise is visible while
 * working, so it says where the data went, not just that something happened.
 *
 * Says what is actually true.
 *
 * "Saved locally" while an edit is still queued would be a small lie, and the
 * whole point of the indicator is that the user can stop thinking about saving.
 * Unsaved work is named as such, briefly, until the write lands.
 */
function saveLabel(save: { status: string; message?: string }, durable: boolean) {
  if (!durable) return 'In memory only';
  switch (save.status) {
    case 'saving':
      return 'Saving…';
    case 'error':
      return save.message ?? 'Could not save locally';
    case 'dirty':
      return 'Unsaved changes';
    default:
      return (
        <>
          <Icon name="lock" /> Saved locally
        </>
      );
  }
}

interface StatusBarProps {
  durable: boolean;
  /** While presenting, only a conflict (if any) is shown — the rest of the bar stays hidden. */
  presenting?: boolean;
  /** See `DocumentSession.resolveConflict`. */
  onResolveConflict?: (choice: 'keep' | 'discard') => void;
}

function ConflictChoice({ conflict, onResolveConflict }: { conflict: 'changed' | 'deleted'; onResolveConflict: (choice: 'keep' | 'discard') => void }) {
  return (
    // Saving waits here until one copy is chosen, so the choice stays on screen, not in a toast.
    <span className="dc-save-conflict" role="group" aria-label="Choose which copy to keep">
      <Button variant="quiet" onClick={() => onResolveConflict('keep')}>
        {conflict === 'deleted' ? 'Keep this canvas' : 'Keep mine'}
      </Button>
      <Button variant="quiet" onClick={() => onResolveConflict('discard')}>
        {conflict === 'deleted' ? 'Close it' : 'Load the other tab’s'}
      </Button>
    </span>
  );
}

export function StatusBar({ durable, presenting = false, onResolveConflict }: StatusBarProps) {
  const save = useEditorStore((state) => state.save);
  const nodeCount = useEditorStore((state) => state.document.nodes.length);
  const edgeCount = useEditorStore((state) => state.document.edges.length);

  // A cross-tab conflict (another tab changed or deleted this canvas) can arrive while presenting;
  // the rest of the status bar stays out of the way, but the conflict itself must still be
  // resolvable — otherwise it sits invisible until the presenter happens to exit.
  if (presenting) {
    if (!save.conflict || !onResolveConflict) return null;
    return (
      <footer className="dc-status">
        <div className="dc-status-left">
          <ConflictChoice conflict={save.conflict} onResolveConflict={onResolveConflict} />
        </div>
      </footer>
    );
  }

  return (
    <footer className="dc-status">
      {__DESKTOP__ && hostKind() === 'desktop' ? (
        <DesktopStatus />
      ) : embeddedHost ? (
        // The host saves the file and shows whether it's dirty; this browser's storage isn't involved.
        <div className="dc-status-left">
          <span className="dc-muted dc-status-hint">This diagram is the open file. Nothing you draw is uploaded.</span>
        </div>
      ) : (
        <div className="dc-status-left">
          <span className="dc-save" data-status={save.status}>
            {saveLabel(save, durable)}
          </span>
          {save.conflict && onResolveConflict && <ConflictChoice conflict={save.conflict} onResolveConflict={onResolveConflict} />}
          {/* Announced separately from the label, which cycles Unsaved → Saving… → Saved on every
              commit and would speak three times per drag. Only a failure is news. */}
          <span className="dc-sr-only" role="status">
            {!durable ? 'Storage unavailable. Changes are kept in memory only.' : save.status === 'error' ? saveLabel(save, durable) : ''}
          </span>
          <span className="dc-muted dc-status-hint" hidden={Boolean(save.conflict)}>
            {durable
              ? 'Your diagrams stay in this browser. Nothing you draw is uploaded.'
              : 'This browser is blocking storage — export to keep your work.'}
          </span>
        </div>
      )}

      <div className="dc-status-right">
        <OpenPointsChip />
        <TakeawaysChip />
        <LevelChip />
        <span className="dc-muted">
          {nodeCount} {nodeCount === 1 ? 'element' : 'elements'} · {edgeCount}{' '}
          {edgeCount === 1 ? 'connector' : 'connectors'}
        </span>
        <span className="dc-inspector-divider" />
        <ZoomControls />
      </div>
    </footer>
  );
}

/**
 * What the discussion has not settled yet — the count of points still open, and the way to the list.
 *
 * Same bargain as the chips beside it: absent until there is something to count, so an ordinary
 * diagram never grows a permanent empty panel; a count you can open once there is. Points are
 * counted, not the markers they put on the canvas — one point about three connectors is one thing to
 * settle. Once everything is resolved the chip stays, quietly, as the way back to what was settled.
 */
function OpenPointsChip() {
  // Root-only and carried into every room, so the room's own view already holds the whole list.
  const total = useEditorStore((state) => pointsOf(state.document).length);
  const open = useEditorStore((state) => unresolvedOpenPoints(state.document).length);
  const panelOpen = useUiStore((state) => state.openPointsPanelOpen);
  if (total === 0) return null;
  const label = count(open, 'open point');
  return (
    <>
      <button
        type="button"
        className="dc-status-open-points"
        data-none={open === 0 || undefined}
        title={open > 0 ? 'Still open — review open points' : 'Every open point is resolved'}
        aria-label={open > 0 ? `${label}, review` : 'Open points, all resolved'}
        aria-expanded={panelOpen}
        onClick={() => useUiStore.getState().setOpenPointsPanelOpen(!panelOpen)}
      >
        <span className="dc-status-open-points-glyph" aria-hidden="true" />
        {open > 0 ? `${open} open` : 'resolved'}
      </button>
      <span className="dc-inspector-divider" />
    </>
  );
}

/**
 * What this canvas has to show for the conversation that produced it.
 *
 * The same bargain `LevelChip` strikes below: absent entirely unless there is something to say,
 * which for most canvases is forever — and a label you can act on, because a count you cannot
 * open is the kind of chrome that sends people looking for a setting.
 *
 * It counts decisions and open questions as well as actions, which are notes already on the
 * canvas (`noteKind`) rather than anything this feature stores. So a diagram drawn long before
 * Takeaways existed opens with the chip already showing — which is, in practice, how most people
 * will find out it is there at all.
 */
function TakeawaysChip() {
  const revision = useEditorStore((state) => state.revision);
  const takeaways = (() => {
    void revision;
    return takeawaysFor(fileOf(useEditorStore.getState()));
  })();
  // Bumped when the nudge folds in. Keyed on it rather than toggled by it, so the animation
  // restarts cleanly on a second arrival instead of being a class that is already applied.
  const pulse = useUiStore((state) => state.takeawaysChipPulse);
  const recalling = useUiStore((state) => state.takeawaysRecall);
  const open = openCount(takeaways);

  // The arrival note points at open actions, so it is over the moment there are none. Opening
  // Takeaways already puts it away; this is for the ways the last action can still go while it is up
  // (an undo, a reload from outside) — without it the flag outlives the bubble, and the next action
  // captured minutes later brings the "you just arrived" note back out of nowhere.
  useEffect(() => {
    if (recalling && open === 0) useUiStore.getState().setTakeawaysRecall(false);
  }, [recalling, open]);

  if (isEmpty(takeaways)) return null;

  const label = open > 0 ? count(open, 'open action') : 'takeaways';
  return (
    <>
      {/* The nudge is positioned against this, not against the corner of the screen: what sits to
          the chip's left changes with the view level and the window width, and a pointer that
          missed what it was pointing at would be worse than no pointer. */}
      <span className="dc-status-takeaways-slot">
        <button
          key={pulse}
          type="button"
          className="dc-status-takeaways"
          data-arrived={pulse > 0 || undefined}
          title={open > 0 ? 'Actions still open — review takeaways' : 'What came out of this discussion'}
          aria-label={open > 0 ? `${label}, review takeaways` : 'Review takeaways'}
          onClick={() => useUiStore.getState().setTakeawaysOpen(true)}
        >
          <span className="dc-status-takeaways-glyph" aria-hidden="true">
            {open > 0 ? '\u25a1' : '\u2713'}
          </span>
          {open > 0 ? open : 'takeaways'}
        </button>
        {open > 0 && <TakeawaysNudge label={label} />}
      </span>
      <span className="dc-inspector-divider" />
    </>
  );
}

/**
 * A small word pointing down at the chip, for the few seconds after a canvas opens.
 *
 * It explains the chip rather than standing in for it. An earlier version of this listed the
 * actions in a card by the corner, and the card was the problem: something big enough to read is
 * something you deal with instead of learning where the count lives, and you learn nothing about
 * a control by being handed its contents. So this says what the number means, points at it, and
 * goes — leaving you knowing one thing you did not know a moment ago.
 *
 * Never focused on arrival, and it does not cover the canvas.
 */
function TakeawaysNudge({ label }: { label: string }) {
  const showing = useUiStore((state) => state.takeawaysRecall);
  const { mounted, closing } = usePopoverPresence(showing, NUDGE_EXIT_MS);

  const settle = useCallback(() => useUiStore.getState().setTakeawaysRecall(false), []);

  // Time is held, not restarted, while the pointer or focus is on it: restarting would make a
  // nudge you glanced at outlast one you ignored. The floor stops it vanishing the instant the
  // pointer leaves, which reads as a glitch rather than as a timeout.
  const remaining = useRef(RECALL_MS);
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  /** Stops the clock without forgetting how much of it is left. */
  const stop = useCallback(() => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const run = useCallback(() => {
    if (timer.current !== undefined) return;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(settle, remaining.current);
  }, [settle]);

  const hold = useCallback(() => {
    if (timer.current === undefined) return;
    const spent = Date.now() - startedAt.current;
    stop();
    remaining.current = Math.max(RECALL_FLOOR_MS, remaining.current - spent);
  }, [stop]);

  useEffect(() => {
    if (!showing) return;
    run();
    // `stop`, not a bare `clearTimeout`: the handle has to be forgotten as well as cancelled.
    // StrictMode runs this effect twice, and a second `run()` that still saw a live handle would
    // decline to reschedule the timer the first cleanup had just cancelled — leaving the nudge up
    // for good. It only ever showed in a browser, never in a test.
    return stop;
  }, [run, showing, stop]);

  if (!mounted) return null;
  return (
    <button
      type="button"
      className="dc-takeaways-nudge"
      data-closing={closing || undefined}
      onPointerEnter={hold}
      onPointerLeave={run}
      onFocus={hold}
      onBlur={run}
      onClick={() => {
        settle();
        useUiStore.getState().setTakeawaysOpen(true);
      }}
      onKeyDown={(event) => {
        // Settles it and stops there. The Escape cascade in `EditorScreen` is guarded on the panel
        // being open, and a nudge must never be the reason a selection got cleared.
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        settle();
      }}
    >
      {label}
      <span className="dc-takeaways-nudge-tail" aria-hidden="true" />
    </button>
  );
}

/**
 * What this view is showing, when anything is known about that — "Containers", "Components".
 *
 * It earns its place by being the answer to a question the suggestions would otherwise raise
 * silently: a known level narrows what Draft Canvas offers here, so it is never narrowed without
 * the reason being on screen. Absent entirely for a canvas nobody has said anything about, which
 * is most of them.
 */
function LevelChip() {
  const level = useEditorStore((state) => viewLevel(state));
  if (!level || level === 'none') return null;
  return (
    <>
      {/* The thing that says what this view shows is also the way to say something else — a label
          you cannot act on is the kind of chrome that makes people go looking for a setting. */}
      <button
        type="button"
        className="dc-status-level"
        title={`${LEVEL_HINTS[level]} — change what this view shows`}
        onClick={() => useUiStore.getState().openCommandPaletteAt('View level')}
      >
        {LEVEL_LABELS[level]}
      </button>
      <span className="dc-inspector-divider" />
    </>
  );
}

/**
 * Its own component, subscribed to the rounded percentage only: the zoom changes on every frame of a
 * wheel zoom or camera move, and the rest of the status bar — hidden entirely while presenting —
 * shouldn't re-render with it.
 */
function ZoomControls() {
  const percent = useStore((state) => Math.round(state.transform[2] * 100));
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <>
      <Button variant="quiet" onClick={() => void zoomOut()} aria-label="Zoom out">
        −
      </Button>
      <button
        type="button"
        className="dc-zoom-value"
        aria-label={`${percent}%, fit to view`}
        onClick={() => void fitView({ padding: 0.2, duration: motionMs(300), nodes: flowFitViewNodes(useEditorStore.getState()) })}
        title="Fit to view"
      >
        {percent}%
      </button>
      <Button variant="quiet" onClick={() => void zoomIn()} aria-label="Zoom in">
        +
      </Button>
    </>
  );
}
