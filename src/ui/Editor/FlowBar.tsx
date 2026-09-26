import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore, useStoreApi } from '@xyflow/react';
import { categoryOf } from '../../document/connectorSemantics';
import { effectiveConnectorText } from '../../document/edgeSemantics';
import { displayNameFor } from '../../document/factory';
import type { DraftEdge, DraftFlow, DraftNode } from '../../document/types';
import { isActivatableTarget, isEditableTarget, overlayAboveCanvasIsOpen } from '../../lib/isEditableTarget';
import { count } from '../../lib/plural';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import { crossedBoundaries } from '../../presentation/composition';
import { orderedWithVariants, routeOf } from '../../presentation/flowChrome';
import { captionCornerFor, screenRectOf } from '../../presentation/framing';
import {
  describePresentationSubject,
  presentationScope,
  resolvePresentationSubject,
  revealIn,
} from '../../presentation/presentationAttachments';
import { CAPTION_SIZE, PRESENTATION_INSETS, type FlowPlaybackController, type FlowPlaybackStep } from '../../presentation/useFlowPlayback';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { ReadOnlyCode } from '../../canvas/AttachmentPresentation';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { Tooltip } from '../common/Tooltip';
import { useFocusReturn } from '../common/useFocusReturn';

/** How long the strip waits, with no pointer or key, before receding. */
const RECEDE_AFTER_MS = 2800;
/** Past this many steps the timeline is a scrubber rather than a row of chapter marks. */
const TIMELINE_TICK_LIMIT = 14;

/**
 * Presentation Mode's chrome — the one thing on screen besides the diagram, in four pieces that
 * never show at once with each other except the strip:
 *
 *   - the opening card (the flow's title over its whole path, before step 1),
 *   - the step caption (who to whom, what the step says, the chips that carry its meaning),
 *   - the closing card (the end of the flow: replay, or on to the next),
 *   - the control strip, which recedes while the presenter talks and returns on any movement.
 *
 * Two kinds of movement live on the strip, and keeping them legibly apart is most of its design:
 * stepping *within* a flow (the chevrons and timeline in the middle, `→`/`←`/`Space`) and leaving
 * one flow for *another* (the flow controls on the left, `Shift+→`/`Shift+←`). A presenter answering
 * a question mid-sentence has to reach for the second without thinking, and without landing on the
 * first by mistake. The camera has its own two: Overview (`O`) pulls back with the step kept, and
 * Re-centre (`R`) hands the camera back after a manual pan. The pointer (`P`) is for pointing.
 */
export function FlowBar({ playback }: { playback: FlowPlaybackController }) {
  // Only while presenting — the bar isn't shown otherwise, so it needn't follow every edit.
  const document = useEditorStore((state) => (playback.active ? state.document : null));
  const mode = useEditorStore((state) => state.mode);
  const reveal = useUiStore((state) =>
    playback.active ? revealIn(state.presentationReveal, presentationScope({ ...playback, flowId: playback.flow?.id ?? null })) : null,
  );
  const framing = useUiStore((state) => state.presentation.framing);
  const pointer = useUiStore((state) => state.presentation.pointer);
  const idle = useUiStore((state) => state.presentation.idle);
  // Which flow the picker was opened over, rather than a bare boolean — so "the question has been
  // answered" is *derived* from arriving somewhere else rather than swept up by an effect after
  // the fact. Switching flow, ending the walkthrough and leaving presentation all close it for
  // free, including the one that bit: exiting with it open and presenting again later.
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const pickerOpen = playback.active && pickerFor !== null && pickerFor === playback.flow?.id;
  const closePicker = useCallback(() => setPickerFor(null), []);

  const leave = useCallback(() => {
    setPickerFor(null);
    playback.stop();
    if (useEditorStore.getState().mode === 'present') useEditorStore.getState().setMode('edit');
  }, [playback]);

  const togglePointer = useCallback(() => {
    const ui = useUiStore.getState();
    ui.setPresentation({ pointer: !ui.presentation.pointer });
  }, []);
  const toggleOverview = useCallback(() => {
    if (useUiStore.getState().presentation.framing === 'overview') playback.resumeFraming();
    else playback.overview();
  }, [playback]);

  useEffect(() => {
    if (!playback.active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // No editable surface is actually reachable while presenting today, but every other
      // shortcut listener in the app guards against one the same way (`EditorScreen.tsx`) — kept
      // consistent here as defense-in-depth for whatever's added next.
      if (isEditableTarget(event.target)) return;
      // Escape is deliberately NOT handled here — `EditorScreen.tsx`'s own central Escape
      // cascade already stops playback (and exits present mode) whenever `playback.active` is
      // true, which covers `picking` too (a `flowId === null` sub-state of `active`, not a
      // separate one). A second listener here used to race it; one owner is enough. The flow
      // picker is the same rule from the other side: it owns its own Escape on a React handler
      // that stops the event dead, so the cascade never sees a press meant for it.
      if (playback.picking) return;
      // ⌘E and ? stay live while presenting, and their dialogs own the arrows and Space: without
      // this the walkthrough stepped on behind the Export sheet. The open flow picker is a
      // `role="menu"`, so this stands the whole bar down while it is up — a stray arrow with
      // focus somewhere else can't step the walkthrough behind it either.
      if (overlayAboveCanvasIsOpen()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Space on a focused bar button (Previous, Exit…) is that button's click, not "next".
      if (event.key === ' ' && isActivatableTarget(event.target)) return;
      // Arrows and Space on a focused, scrollable callout code block scroll it.
      if (event.target instanceof Element && event.target.closest('[data-callout-scroll]')) return;
      // Shift first, and returning either way: the same axis, a bigger move. Checked ahead of the
      // plain arrows so the modifier can't fall through to stepping, which is what it used to do.
      if (event.shiftKey) {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          playback.nextFlow();
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          playback.previousFlow();
        } else if (event.key === 'F' || event.key === 'f') {
          // Not bare `F` (that is the editor's Flows panel, and `EditorScreen.tsx` keeps
          // presentation's bare-key list to Escape and the capture key on purpose) — but the
          // presentation's own F, which is what someone who knows the editor reaches for.
          event.preventDefault();
          setPickerFor(playback.flow?.id ?? null);
        }
        return;
      }
      // The arrows on a focused scrubber are the scrubber's own (`isEditableTarget` knows a range
      // input); everything below is for the rest of the screen.
      switch (event.key) {
        case 'ArrowRight':
        case ' ':
          event.preventDefault();
          playback.next();
          return;
        case 'ArrowLeft':
          event.preventDefault();
          playback.previous();
          return;
        case 'Home':
          event.preventDefault();
          playback.first();
          return;
        case 'End':
          event.preventDefault();
          playback.last();
          return;
        case 'o':
        case 'O':
          event.preventDefault();
          toggleOverview();
          return;
        case 'r':
        case 'R':
          event.preventDefault();
          playback.resumeFraming();
          return;
        case 'p':
        case 'P':
          event.preventDefault();
          togglePointer();
          return;
        default: {
          // A digit jumps straight to that step — the way a chapter number does — when there is one.
          const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
          if (digit > 0 && digit <= playback.steps.length) {
            event.preventDefault();
            playback.goTo(digit);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playback, toggleOverview, togglePointer]);

  // A presenter's reveal (a chip or badge clicked while presenting — see `presentationReveal`) is
  // scoped to the step it was made on (`revealIn` ignores it elsewhere, from the very first render),
  // and this lets it go too: stepping, starting or stopping a flow, or leaving presentation, so a
  // stale one isn't kept around to match again by coincidence.
  useEffect(() => {
    useUiStore.getState().setPresentationReveal(null);
  }, [playback.step, playback.stage, playback.flow?.id, playback.active, mode]);

  // The strip recedes while the presenter talks — nothing moved, nothing pressed — and comes back
  // on the first movement, keypress or focus. Written to the store only on the flip, never per
  // pointer frame (`setPresentation` refuses an unchanged write).
  useEffect(() => {
    if (!playback.active) return;
    let timer = 0;
    const rest = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => useUiStore.getState().setPresentation({ idle: true }), RECEDE_AFTER_MS);
    };
    const wake = () => {
      useUiStore.getState().setPresentation({ idle: false });
      rest();
    };
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake);
    rest();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      useUiStore.getState().setPresentation({ idle: false });
    };
  }, [playback.active]);

  if (!playback.active) return null;

  // Before any flow has been chosen, the picker *is* the bar — the same list and the same keys, so
  // the choice made on the way in and the one made mid-presentation are one gesture to learn.
  if (playback.picking) {
    return (
      <div className="dc-explain" role="region" aria-label="Choose a flow">
        <FlowPicker playback={playback} onClose={leave} closeLabel="Exit" heading="Present which flow?" />
      </div>
    );
  }

  if (!playback.flow || !document) return null;

  const nodes = nodeIndex(document.nodes);
  const { flows, flowIndex, stage } = playback;
  // One flow is just a walkthrough: no position to report and nowhere to skip to, so none of the
  // flow chrome appears at all and the bar stays as small as it was.
  const manyFlows = flows.length > 1;
  const upcoming = flowIndex >= 0 ? flows[flowIndex + 1] : undefined;
  const total = playback.steps.length;
  const primary = playback.current?.edge;
  const details = primary?.details;
  // What the step's callout shows (`PresentationCalloutLayer`), folded into the one announcement.
  const spoken = playback.current
    ? resolvePresentationSubject({
        flowId: playback.flow.id,
        steps: playback.steps,
        step: playback.step,
        nodesById: nodes,
        edgesById: edgeIndex(document.edges),
        reveal,
      })
    : null;
  const story = playback.current ? describeStep(playback.current, nodes) : null;
  const position = manyFlows ? `${playback.flow.title}, flow ${flowIndex + 1} of ${flows.length}. ` : '';
  const announcement =
    stage === 'opening'
      ? `${position}${playback.flow.title}: ${count(total, 'step')}. Press the right arrow to begin.`
      : stage === 'closing'
        ? `${position}End of ${playback.flow.title}.${upcoming ? ` Next flow: ${upcoming.title}.` : ' End of the presentation.'}`
        : `${position}Step ${playback.step} of ${total}: ${story?.headline ?? ''}${story?.caption ? `. ${story.caption}` : ''}${spoken ? `. ${describePresentationSubject(spoken)}` : ''}`;

  return (
    <>
      {stage === 'opening' && (
        <PresentationCard kind="opening" flow={playback.flow} playback={playback} title={document.metadata.title} nodes={nodes} />
      )}
      {stage === 'closing' && (
        <PresentationCard kind="closing" flow={playback.flow} playback={playback} title={document.metadata.title} nodes={nodes} />
      )}
      {stage === 'step' && playback.current && story && (
        <StepCaption step={playback.current} story={story} total={total} flow={playback.flow} nodes={nodes} />
      )}

      <div
        className="dc-explain"
        role="region"
        aria-label="Flow playback"
        data-receded={idle && !pickerOpen ? 'true' : undefined}
        data-stage={stage}
      >
        {pickerOpen && (
          <FlowPicker
            playback={playback}
            onClose={closePicker}
            closeLabel="Close"
            heading="Flows you can present"
          />
        )}
        {details && <DetailPanel language={details.language} code={details.code} />}

        {/* The bar changes in place as the presenter steps, which a screen reader wouldn't notice. */}
        <span className="dc-sr-only" role="status">
          {announcement}
        </span>
        <div className="dc-explain-bar">
          {manyFlows && (
            <Button
              icon="flowPrevious"
              variant="quiet"
              aria-label="Previous flow"
              disabled={flowIndex <= 0}
              onClick={playback.previousFlow}
            />
          )}
          <button
            type="button"
            className="dc-explain-flow-pick"
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            title={playback.flow.title}
            onClick={() => setPickerFor(pickerOpen ? null : playback.flow?.id ?? null)}
          >
            <span className="dc-explain-flow-title">{playback.flow.title}</span>
            {manyFlows && (
              <span className="dc-explain-flow-pos">
                Flow {flowIndex + 1} of {flows.length}
              </span>
            )}
            <Icon name="down" size={13} />
          </button>
          {manyFlows && (
            <Button
              icon="flowNext"
              variant="quiet"
              // At the end of a flow the next one names itself: the hand-off is the thing the
              // presenter is about to say out loud, not a bare arrow they have to remember.
              aria-label={upcoming ? `Next flow: ${upcoming.title}` : 'Next flow'}
              disabled={!upcoming}
              onClick={playback.nextFlow}
            >
              {stage === 'closing' && upcoming ? <span className="dc-explain-next-flow">{upcoming.title}</span> : undefined}
            </Button>
          )}
          <span className="dc-inspector-divider" />
          <Button
            icon="back"
            variant="quiet"
            aria-label="Previous step"
            disabled={stage === 'opening'}
            onClick={playback.previous}
          />
          <Timeline playback={playback} nodes={nodes} />
          {playback.atEnd ? (
            <span className="dc-explain-end">End</span>
          ) : (
            <Button
              icon="forward"
              variant="quiet"
              aria-label={stage === 'opening' ? 'Begin' : stage === 'closing' ? (upcoming ? `Next flow: ${upcoming.title}` : 'Next step') : 'Next step'}
              onClick={playback.next}
            />
          )}
          <span className="dc-explain-count" aria-hidden="true">
            {stage === 'step' ? `Step ${playback.step} / ${total}` : count(total, 'step')}
          </span>
          <span className="dc-inspector-divider" />
          {framing === 'manual' ? (
            <Tooltip content={{ title: 'Re-centre on the step', shortcut: 'R' }}>
              {(tip) => (
                <Button
                  {...tip}
                  icon="overview"
                  variant="quiet"
                  aria-label="Re-centre on the step"
                  className="dc-explain-reframe"
                  onClick={playback.resumeFraming}
                >
                  Re-centre
                </Button>
              )}
            </Tooltip>
          ) : (
            <Tooltip content={{ title: framing === 'overview' ? 'Back to the step' : 'Overview, keeping the step', shortcut: 'O' }}>
              {(tip) => (
                <Button
                  {...tip}
                  icon="overview"
                  variant="quiet"
                  active={framing === 'overview'}
                  aria-label={framing === 'overview' ? 'Back to the step' : 'Overview'}
                  onClick={toggleOverview}
                />
              )}
            </Tooltip>
          )}
          <Tooltip content={{ title: pointer ? 'Pointer off' : 'Pointer', shortcut: 'P' }}>
            {(tip) => <Button {...tip} icon="pointer" variant="quiet" active={pointer} aria-label="Pointer" onClick={togglePointer} />}
          </Tooltip>
          <Button variant="quiet" onClick={leave}>
            Exit
          </Button>
        </div>
      </div>
    </>
  );
}

interface StepStory {
  /** "Orders API → Payments", or the spotlit shapes of a frame step. */
  headline: string;
  from?: string;
  to?: string;
  /** The step's own caption, else what the connector says on the canvas. */
  caption?: string;
}

/** The words a step is told with — every one already on the canvas or in the flow. */
function describeStep(step: FlowPlaybackStep, nodes: ReadonlyMap<string, DraftNode>): StepStory {
  const primary = step.edge;
  if (!primary) {
    const named = step.extraNodes.map((node) => displayNameFor(node)).join(', ');
    return { headline: named || 'Frame', caption: step.caption };
  }
  const source = nodes.get(primary.source);
  const target = nodes.get(primary.target);
  const from = source ? displayNameFor(source) : 'Untitled';
  const to = target ? displayNameFor(target) : 'Untitled';
  // `primary.label` alone left the caption silent on every connector whose meaning comes from its
  // relationship rather than typed text — see `effectiveConnectorText`.
  const caption =
    step.caption ||
    effectiveConnectorText(primary, {
      source: source ? categoryOf(source) : undefined,
      target: target ? categoryOf(target) : undefined,
    }) ||
    undefined;
  return { headline: `${from} to ${to}`, from, to, caption };
}

/** The connector's own semantics, as chips — shown, never inferred beyond what the edge says. */
function chipsFor(edge: DraftEdge | undefined, parallel: number, crossed: DraftNode[]): { key: string; text: string; tone?: 'warn' }[] {
  const chips: { key: string; text: string; tone?: 'warn' }[] = [];
  if (!edge) return chips;
  if (edge.condition) chips.push({ key: 'condition', text: `[${edge.condition}]` });
  if (edge.async || edge.kind === 'async' || edge.kind === 'event') chips.push({ key: 'async', text: edge.kind === 'event' ? 'event' : 'async' });
  if (edge.kind && edge.kind !== 'sync' && edge.kind !== 'async' && edge.kind !== 'event') {
    chips.push({ key: 'kind', text: edge.kind, tone: edge.kind === 'failure' ? 'warn' : undefined });
  }
  if (edge.hasResponse) chips.push({ key: 'response', text: edge.response ? `↩ ${edge.response}` : '↩ reply' });
  for (const boundary of crossed) chips.push({ key: `crosses:${boundary.id}`, text: `crosses ${boundaryName(boundary)}` });
  if (parallel > 1) chips.push({ key: 'parallel', text: `${parallel} in parallel` });
  return chips;
}

/** A boundary by its name — or, unnamed, by what kind of boundary it is ("the deployment boundary"). */
function boundaryName(boundary: DraftNode): string {
  const name = boundary.text?.trim();
  if (name) return name;
  const preset = boundary.boundaryPreset ?? 'boundary';
  return preset === 'boundary' || preset === 'group' ? 'a boundary' : `the ${preset} boundary`;
}

/**
 * The step caption: who to whom, what the step says, and the chips that carry the connector's
 * meaning — in the corner of the canvas the camera left clear (`captionCornerFor`), and moved out
 * of the way again if the presenter pans the interaction under it.
 */
function StepCaption({
  step,
  story,
  total,
  flow,
  nodes,
}: {
  step: FlowPlaybackStep;
  story: StepStory;
  total: number;
  flow: DraftFlow;
  nodes: ReadonlyMap<string, DraftNode>;
}) {
  const corner = useUiStore((state) => state.presentation.captionCorner);
  useCaptionFollowsCamera();
  const crossed = useMemo(
    () => (step.edge ? crossedBoundaries(nodes, step.edge.source, step.edge.target) : []),
    [nodes, step.edge],
  );
  const chips = chipsFor(step.edge, step.edges.length, crossed);
  const base = useEditorStore((state) => (flow.variantOf ? state.document.flows.find((f) => f.id === flow.variantOf) : undefined));
  return (
    <div className="dc-present-caption" data-corner={corner} aria-hidden="true">
      <span className="dc-present-eyebrow">
        Step {step.step} of {total}
        {base ? <> · variant of {base.title}</> : null}
      </span>
      <span className="dc-present-headline">
        {story.from && story.to ? (
          <>
            <span className="dc-present-name">{story.from}</span>
            <span className="dc-present-arrow">→</span>
            <span className="dc-present-name">{story.to}</span>
          </>
        ) : (
          <span className="dc-present-name">{story.headline}</span>
        )}
      </span>
      {story.caption && <span className="dc-present-text">{story.caption}</span>}
      {chips.length > 0 && (
        <span className="dc-present-chips">
          {chips.map((chip) => (
            <span key={chip.key} className="dc-present-chip" data-tone={chip.tone}>
              {chip.text}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * Keeps the caption off the interaction while the presenter moves the camera by hand. Guided
 * moves choose the corner as they frame; a manual pan can slide the interaction under the caption,
 * so the camera is watched — a store subscription, no React render per frame, and a write only
 * when the corner actually changes.
 */
function useCaptionFollowsCamera() {
  const storeApi = useStoreApi();
  const viewWidth = useStore((state) => state.width);
  const viewHeight = useStore((state) => state.height);
  useEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const ui = useUiStore.getState();
      if (ui.presentation.framing !== 'manual' || !ui.presentation.focus) return;
      const [x, y, zoom] = storeApi.getState().transform;
      const rect = screenRectOf(ui.presentation.focus, { x, y, zoom });
      ui.setPresentation({ captionCorner: captionCornerFor(rect, { width: viewWidth, height: viewHeight }, PRESENTATION_INSETS, CAPTION_SIZE) });
    };
    const unsubscribe = storeApi.subscribe((state, previous) => {
      if (state.transform === previous.transform) return;
      if (!frame) frame = requestAnimationFrame(place);
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [storeApi, viewHeight, viewWidth]);
}

/**
 * The opening and the closing: a card in the canvas's corner while the whole flow is on screen.
 * The opening says what is about to be told — the flow's title, the shapes its path passes through
 * and how many steps it takes, all read from the flow itself; the closing says it has been, and
 * offers to tell it again or go on to the next.
 */
function PresentationCard({
  kind,
  flow,
  playback,
  title,
  nodes,
}: {
  kind: 'opening' | 'closing';
  flow: DraftFlow;
  playback: FlowPlaybackController;
  title: string;
  nodes: ReadonlyMap<string, DraftNode>;
}) {
  const route = useMemo(() => routeOf(playback.steps, nodes), [playback.steps, nodes]);
  const upcoming = playback.flowIndex >= 0 ? playback.flows[playback.flowIndex + 1] : undefined;
  const manyFlows = playback.flows.length > 1;
  const base = useEditorStore((state) => (flow.variantOf ? state.document.flows.find((f) => f.id === flow.variantOf) : undefined));
  return (
    <div className="dc-present-card" data-kind={kind} role={kind === 'closing' ? 'group' : undefined} aria-label={kind === 'closing' ? 'End of flow' : undefined}>
      <span className="dc-present-eyebrow">
        {kind === 'opening' ? title : 'End of flow'}
        {manyFlows && (
          <>
            {' · '}Flow {playback.flowIndex + 1} of {playback.flows.length}
          </>
        )}
      </span>
      <span className="dc-present-title">{flow.title}</span>
      {base && <span className="dc-present-text">A variant of {base.title}</span>}
      {route.length > 0 && (
        <span className="dc-present-route" aria-hidden={kind === 'closing' ? true : undefined}>
          {route.map((name, index) => (
            <span key={`${name}:${index}`} className="dc-present-route-stop">
              {index > 0 && <span className="dc-present-arrow">→</span>}
              {name}
            </span>
          ))}
        </span>
      )}
      {kind === 'opening' ? (
        <span className="dc-present-meta">
          {count(playback.steps.length, 'step')}
          <span className="dc-present-hint">
            <kbd>→</kbd> to begin
          </span>
        </span>
      ) : (
        <span className="dc-present-actions">
          <Button variant="ghost" icon="undo" onClick={playback.replay}>
            Replay
          </Button>
          {upcoming && (
            <Button variant="solid" icon="flowNext" onClick={playback.nextFlow}>
              Next: {upcoming.title}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Direct navigation: a chapter mark per step (each a button naming its step), or a scrubber once
 * there are too many to tell apart. The current one is the accent; the ones already told are
 * filled; the rest are outlines — the story's shape at a glance, and a way to jump anywhere in it.
 */
function Timeline({ playback, nodes }: { playback: FlowPlaybackController; nodes: ReadonlyMap<string, DraftNode> }) {
  const { steps, step, stage } = playback;
  if (steps.length === 0) return null;
  const covered = stage === 'closing' ? steps.length : stage === 'opening' ? 0 : step;
  if (steps.length > TIMELINE_TICK_LIMIT) {
    return (
      <input
        className="dc-present-scrubber"
        type="range"
        min={1}
        max={steps.length}
        value={Math.max(1, covered)}
        aria-label="Step"
        aria-valuetext={stage === 'step' ? `Step ${step} of ${steps.length}` : stage === 'opening' ? 'Opening' : 'End'}
        onChange={(event) => playback.goTo(Number(event.target.value))}
      />
    );
  }
  return (
    <ol className="dc-present-timeline" aria-label="Steps">
      {steps.map((entry) => {
        const current = stage === 'step' && entry.step === step;
        return (
          <li key={entry.step}>
            <button
              type="button"
              className="dc-present-tick"
              data-covered={entry.step <= covered ? 'true' : undefined}
              aria-current={current ? 'step' : undefined}
              aria-label={`Step ${entry.step}: ${describeStep(entry, nodes).headline}`}
              title={`${entry.step}. ${describeStep(entry, nodes).headline}`}
              onClick={() => playback.goTo(entry.step)}
            />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The list of flows worth presenting — the one surface for both "which flow shall I start with?"
 * and "let me jump to the one they just asked about", so the two can't drift apart.
 *
 * It is a `role="menu"`, which is load-bearing beyond semantics: `overlayAboveCanvasIsOpen`
 * already matches one, so while it is up the bar's own arrow keys stand down and a press can't
 * step the walkthrough behind it. It owns Escape on a React handler that stops the event dead,
 * rather than adding a second `window` listener to race `EditorScreen`'s Escape cascade — a bug
 * this file has had before.
 *
 * Titled by what it actually offers: a flow with no steps yet cannot be presented and isn't here,
 * so a document with five flows can legitimately show three rows. Saying "flows you can present"
 * is what makes that read as a fact about them rather than as something missing.
 */

function FlowPicker({
  playback,
  onClose,
  closeLabel,
  heading,
}: {
  playback: FlowPlaybackController;
  onClose: () => void;
  closeLabel: string;
  heading: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusReturn(true);

  // Focus lands inside on open — both so the arrow keys below reach it, and because the Escape
  // handler is a React one: with focus left outside, a press would fall through to the editor's
  // cascade and end the presentation instead of closing this.
  useEffect(() => {
    const current =
      rootRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      rootRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]');
    current?.focus();
  }, []);

  // A click anywhere else is an answer too — "not this one, carry on".
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const items = () => Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'Escape':
        consume();
        onClose();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        // Consumed even with nowhere to go: an arrow that escaped this would step the walkthrough
        // underneath, which is the opposite of what the presenter just asked for.
        consume();
        const all = items();
        const at = all.indexOf(event.target as HTMLElement);
        all[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
        return;
      }
      case 'Home':
      case 'End': {
        consume();
        const all = items();
        (event.key === 'Home' ? all[0] : all[all.length - 1])?.focus();
        return;
      }
      default:
        // Left/Right are deliberately not handled: they belong to the walkthrough, and a vertical
        // list claiming them would make one key mean two things on the same screen.
        return;
    }
  };

  return (
    <div className="dc-flow-picker" ref={rootRef} role="menu" aria-label={heading} onKeyDown={onKeyDown}>
      <div className="dc-flow-picker-head">
        <span className="dc-flow-picker-title">{heading}</span>
        <Button variant="quiet" onClick={onClose}>
          {closeLabel}
        </Button>
      </div>
      <div className="dc-flow-picker-list">
        {orderedWithVariants(playback.flows).map(({ flow, variant }, index) => {
          const current = flow.id === playback.flow?.id;
          return (
            <button
              key={flow.id}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              // The flow's own name, and only that: the position and step count beside it are
              // orientation for the eye, not part of what this row is called.
              aria-label={flow.title}
              className={variant ? 'dc-flow-picker-item dc-flow-picker-item-variant' : 'dc-flow-picker-item'}
              title={flow.title}
              onClick={() => {
                if (current) onClose();
                else playback.pickFlow(flow.id);
              }}
            >
              <span className="dc-flow-picker-mark" aria-hidden="true">
                {current ? <Icon name="check" size={13} /> : index + 1}
              </span>
              <span className="dc-flow-picker-name">{flow.title}</span>
              <span className="dc-flow-picker-steps">{count(flow.steps.length, 'step')}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Expandable technical detail attached to a connection — a payload, a header
 * block, an error. It stays out of the canvas so the diagram remains readable,
 * and appears only for the step being explained.
 */
function DetailPanel({ language, code }: { language: Parameters<typeof ReadOnlyCode>[0]['language']; code: string }) {
  return (
    <div className="dc-explain-detail">
      <ReadOnlyCode language={language} code={code} />
    </div>
  );
}
