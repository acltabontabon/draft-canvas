import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { categoryOf } from '../../document/connectorSemantics';
import { effectiveConnectorText } from '../../document/edgeSemantics';
import { displayNameFor } from '../../document/factory';
import { isActivatableTarget, isEditableTarget, overlayAboveCanvasIsOpen } from '../../lib/isEditableTarget';
import { count } from '../../lib/plural';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import {
  describePresentationSubject,
  presentationScope,
  resolvePresentationSubject,
  revealIn,
} from '../../presentation/presentationAttachments';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { ReadOnlyCode } from '../../canvas/AttachmentPresentation';
import type { FlowPlaybackController } from '../../presentation/useFlowPlayback';
import type { DraftFlow } from '../../document/types';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { useFocusReturn } from '../common/useFocusReturn';

/**
 * Presentation Mode's control. Present while playing a flow, and the only
 * chrome visible in presentation mode — the canvas itself carries the story.
 *
 * It carries two kinds of movement, and keeping them legibly apart is most of its design: stepping
 * *within* a flow (the chevrons on the right, `→`/`←`/`Space`) and leaving one flow for *another*
 * (the skip controls and the picker on the left, `Shift+→`/`Shift+←`). A presenter answering a
 * question mid-sentence has to reach for the second without thinking, and without landing on the
 * first by mistake.
 */
export function FlowBar({ playback }: { playback: FlowPlaybackController }) {
  // Only while presenting — the bar isn't shown otherwise, so it needn't follow every edit.
  const document = useEditorStore((state) => (playback.active ? state.document : null));
  const mode = useEditorStore((state) => state.mode);
  const reveal = useUiStore((state) =>
    playback.active ? revealIn(state.presentationReveal, presentationScope({ ...playback, flowId: playback.flow?.id ?? null })) : null,
  );
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
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        playback.next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        playback.previous();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playback]);

  // A presenter's reveal (a chip or badge clicked while presenting — see `presentationReveal`) is
  // scoped to the step it was made on (`revealIn` ignores it elsewhere, from the very first render),
  // and this lets it go too: stepping, starting or stopping a flow, or leaving presentation, so a
  // stale one isn't kept around to match again by coincidence.
  useEffect(() => {
    useUiStore.getState().setPresentationReveal(null);
  }, [playback.step, playback.flow?.id, playback.active, mode]);

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

  if (!playback.current || !playback.flow || !document) return null;

  const nodes = nodeIndex(document.nodes);
  const primary = playback.current.edge;
  const source = primary ? nodes.get(primary.source) : undefined;
  const target = primary ? nodes.get(primary.target) : undefined;
  const details = primary?.details;
  // The step's own caption, else what the connector says on the canvas. `primary.label` alone left
  // the bar (and the announcement below) silent on every connector whose meaning comes from its
  // relationship rather than typed text — see `effectiveConnectorText`.
  const caption =
    playback.current.caption ||
    (primary
      ? effectiveConnectorText(primary, {
          source: source ? categoryOf(source) : undefined,
          target: target ? categoryOf(target) : undefined,
        })
      : undefined);
  const condition = primary?.condition;
  // What the step's callout shows (`PresentationCalloutLayer`), folded into the one announcement.
  const spoken = resolvePresentationSubject({
    flowId: playback.flow.id,
    steps: playback.steps,
    step: playback.step,
    nodesById: nodes,
    edgesById: edgeIndex(document.edges),
    reveal,
  });

  const { flows, flowIndex } = playback;
  // One flow is just a walkthrough: no position to report and nowhere to skip to, so none of the
  // flow chrome appears at all and the bar stays as small as it was.
  const manyFlows = flows.length > 1;
  const upcoming = flowIndex >= 0 ? flows[flowIndex + 1] : undefined;
  const atLastStep = playback.step >= playback.steps.length;
  // The end of the last flow is the end of the presentation, and says so rather than leaving a
  // dead arrow to press. Nothing ever wraps back round to the first flow.
  const finished = atLastStep && !upcoming;

  return (
    <div className="dc-explain" role="region" aria-label="Flow playback">
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
        {`${manyFlows ? `${playback.flow.title}, flow ${flowIndex + 1} of ${flows.length}. ` : ''}Step ${playback.step} of ${playback.steps.length}: ${
          primary
            ? `${source ? displayNameFor(source) : 'Untitled'} to ${target ? displayNameFor(target) : 'Untitled'}`
            : playback.current.extraNodes.map((n) => displayNameFor(n)).join(', ')
        }${caption ? `. ${caption}` : ''}${spoken ? `. ${describePresentationSubject(spoken)}` : ''}`}
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
            {atLastStep && upcoming ? <span className="dc-explain-next-flow">{upcoming.title}</span> : undefined}
          </Button>
        )}
        <span className="dc-inspector-divider" />
        <span className="dc-explain-count">
          Step {playback.step} / {playback.steps.length}
        </span>
        <span className="dc-flow-dots" aria-hidden="true">
          {playback.steps.map((step) => (
            <span
              key={step.step}
              className="dc-flow-dot"
              data-filled={step.step <= playback.step ? 'true' : undefined}
            />
          ))}
        </span>
        {primary ? (
          <span className="dc-explain-flow">
            <strong>{source ? displayNameFor(source) : 'Untitled'}</strong>
            <span className="dc-explain-arrow" aria-hidden="true">
              →
            </span>
            <strong>{target ? displayNameFor(target) : 'Untitled'}</strong>
          </span>
        ) : (
          playback.current.extraNodes.length > 0 && (
            <span className="dc-explain-flow">
              <strong>
                {playback.current.extraNodes.map((n) => displayNameFor(n)).join(', ')}
              </strong>
            </span>
          )
        )}
        {caption && (
          <span className="dc-explain-caption" title={caption}>
            {caption}
          </span>
        )}
        {condition && <span className="dc-explain-condition">[{condition}]</span>}
        <span className="dc-inspector-divider" />
        <Button
          icon="back"
          variant="quiet"
          aria-label="Previous step"
          disabled={playback.step <= 1}
          onClick={playback.previous}
        />
        {finished ? (
          <span className="dc-explain-end">End</span>
        ) : (
          <Button
            icon="forward"
            variant="quiet"
            aria-label="Next step"
            disabled={atLastStep}
            onClick={playback.next}
          />
        )}
        <Button variant="quiet" onClick={leave}>
          Exit
        </Button>
      </div>
    </div>
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

/** Groups a flow with its named variant(s) (e.g. a failure path) right after it, in the picker's
 *  existing order — nothing reordered otherwise, and a variant whose base isn't in this playable
 *  list (rare — the base itself would have to not be presentable) just falls back to its own row. */
export function orderedWithVariants(flows: readonly DraftFlow[]): { flow: DraftFlow; variant: boolean }[] {
  const byId = new Map(flows.map((f) => [f.id, f]));
  const placed = new Set<string>();
  const rows: { flow: DraftFlow; variant: boolean }[] = [];
  for (const flow of flows) {
    if (placed.has(flow.id)) continue;
    if (flow.variantOf && byId.has(flow.variantOf)) continue; // placed alongside its base below
    rows.push({ flow, variant: false });
    placed.add(flow.id);
    for (const candidate of flows) {
      if (candidate.variantOf === flow.id && !placed.has(candidate.id)) {
        rows.push({ flow: candidate, variant: true });
        placed.add(candidate.id);
      }
    }
  }
  return rows;
}

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
