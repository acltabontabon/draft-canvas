import { useEffect, useRef, useState } from 'react';
import { isCanvasEmpty } from '../../document/operations';
import { MOD_SYMBOL, plainShortcut } from '../../lib/platform';
import { PRIMARY_STARTERS, type StarterId } from '../../starters';
import { fileOf, useEditorStore, viewLevel } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { ownerAt, viewOf } from '../../depth/tree';
import { looksLikeSystemOverview } from '../../depth/level';
import { displayNameFor } from '../../document/factory';
import { StarterTile } from '../Library/StarterTile';
import { InkedWords } from '../Library/InkedWords';
import { prefersReducedMotion } from '../../lib/motion';
import { StarterPicker } from './StarterPicker';

interface EmptyStateProps {
  /** Runs the palette's own starter command — see `EditorScreen`. */
  onInsertStarter: (id: StarterId) => void;
}

/** How long the layer lingers after the canvas stops being empty, matching `canvas.css`. */
const EXIT_MS = 170;

/**
 * A quiet invitation above five small architecture sketches. `StarterTile` draws the catalog's
 * real topologies; the full collection is a click away, or searchable in the command palette.
 *
 * Only the controls take pointer events; the surrounding copy is decoration over a canvas that
 * must stay double-clickable everywhere else.
 */
export function EmptyState({ onInsertStarter }: EmptyStateProps) {
  const empty = useEditorStore((state) => isCanvasEmpty(state.document));
  const mode = useEditorStore((state) => state.mode);
  const armed = useUiStore((state) => state.armed);
  // Choosing a tool hands the whole canvas back to drawing, including the space under the cards.
  const visible = empty && mode === 'edit' && armed === null;
  /** The shape whose inside this is, when the canvas is showing one. */
  const insideOf = useEditorStore((state) => {
    if (state.path.length === 0) return null;
    const owner = ownerAt(fileOf(state), state.path);
    return owner ? displayNameFor(owner) : 'this shape';
  });

  /*
   * `lingering` holds the layer on screen for one fade after the canvas stops being empty. Driven
   * by the store rather than by anything a user did here, so there is no earlier place to derive it.
   */
  const [lingering, setLingering] = useState(false);
  const wasVisible = useRef(visible);

  /* oxlint-disable react/set-state-in-effect -- what changed is a store transition, not an event
     this component handled, so there is no earlier place to derive the flag from. */
  useEffect(() => {
    const left = wasVisible.current && !visible;
    wasVisible.current = visible;
    if (visible) return;
    // Only something that was actually on screen has anything to fade out — mounting into
    // a full canvas, or into present mode, must not fade in a layer nobody saw.
    if (!left || prefersReducedMotion()) return;
    setLingering(true);
    const timer = setTimeout(() => setLingering(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  /* oxlint-enable react/set-state-in-effect */

  const mounted = visible || lingering;
  if (!mounted) return null;
  // Inside a shape the question is narrower, and so is the answer: this is one system's insides,
  // not a blank page, and offering a whole architecture to drop in here would be answering a
  // question nobody asked. Just the room's own name and what belongs in it.
  if (insideOf) return <EmptyRoom name={insideOf} leaving={!visible} />;
  return <EmptyCanvas onInsertStarter={onInsertStarter} leaving={!visible} />;
}

/** The empty inside of a shape: its name, and the one question worth answering there. */
function EmptyRoom({ name, leaving }: { name: string; leaving: boolean }) {
  return (
    <div className="dc-empty dc-empty-room" data-leaving={leaving ? 'true' : undefined}>
      <span className="dc-empty-crops" aria-hidden="true">
        <span data-at="nw" />
        <span data-at="ne" />
        <span data-at="se" />
        <span data-at="sw" />
      </span>
      <div className="dc-empty-room-note">
        <p className="dc-empty-title">What runs inside {name}?</p>
        <p className="dc-empty-hint">
          Draw it here. {MOD_SYMBOL}↑ goes back out.
        </p>
        <ContextOffer />
      </div>
    </div>
  );
}

/**
 * The one question Draft Canvas ever asks about what a canvas is showing.
 *
 * Only here, only where the drawing outside is shaped like a system overview, and only while
 * nothing has been said about it — so it is an offer to name what someone has already drawn, not a
 * guess acted on behind their back. Answering yes says it of the canvas outside, which is what the
 * claim was about; this room then derives Containers from it, and the status bar says so. Saying
 * no puts it away for the session and nothing is written either way until someone answers.
 */
function ContextOffer() {
  const dismissed = useUiStore((state) => state.overviewOfferDismissed);
  const offered = useEditorStore((state) => {
    if (state.path.length === 0 || viewLevel(state) !== undefined) return false;
    const outside = state.path.length === 1 ? fileOf(state) : viewOf(fileOf(state), state.path.slice(0, -1));
    return outside ? looksLikeSystemOverview(outside) : false;
  });
  if (!offered || dismissed) return null;

  return (
    <p className="dc-empty-offer">
      <span>Looks like a system overview. Treat it as C4 context?</span>
      <button
        type="button"
        className="dc-empty-offer-yes"
        onClick={() => useEditorStore.getState().setOuterViewLevel(useEditorStore.getState().path.length - 1, 'context')}
      >
        Yes
      </button>
      <button type="button" className="dc-empty-offer-no" onClick={() => useUiStore.getState().dismissOverviewOffer()}>
        No thanks
      </button>
    </p>
  );
}

function EmptyCanvas({ onInsertStarter, leaving }: EmptyStateProps & { leaving: boolean }) {
  const [allStartersOpen, setAllStartersOpen] = useState(false);
  return (
    <>
      <div className="dc-empty" data-leaving={leaving ? 'true' : undefined}>
        <div className="dc-empty-stage">
          <div className="dc-empty-start" aria-hidden="true">
            <p className="dc-empty-title">Start <em><InkedWords>drawing.</InkedWords></em></p>
            <p className="dc-empty-hint">Double-click anywhere to add your first shape.</p>
            <p className="dc-empty-keys">
              <span className="dc-empty-key"><kbd>S</kbd> service</span>
              <span className="dc-empty-key"><kbd>N</kbd> note</span>
              <span className="dc-empty-key"><kbd>C</kbd> code</span>
            </p>
          </div>

          <div className="dc-empty-pick">
            <p className="dc-empty-pick-label" aria-hidden="true">Or borrow a starting point</p>
            <div className="dc-empty-rows" role="group" aria-label="Suggested starters">
              {PRIMARY_STARTERS.map((starter, index) => (
                <StarterTile key={starter.id} starter={starter} index={index} onStart={onInsertStarter} />
              ))}
            </div>
            <div className="dc-empty-footer">
              <button type="button" className="dc-empty-action" onClick={() => setAllStartersOpen(true)}>View all starters</button>
              <p className="dc-empty-shortcut" aria-hidden="true">or <kbd>{plainShortcut(`${MOD_SYMBOL} K`)}</kbd> to search</p>
            </div>
          </div>
        </div>
      </div>
      {allStartersOpen && !leaving && (
        <StarterPicker
          onClose={() => setAllStartersOpen(false)}
          onStart={(id) => {
            setAllStartersOpen(false);
            onInsertStarter(id);
          }}
        />
      )}
    </>
  );
}
