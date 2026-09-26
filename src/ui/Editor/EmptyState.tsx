import { useEffect, useRef, useState } from 'react';
import { isCanvasEmpty } from '../../document/operations';
import { MOD_SYMBOL } from '../../lib/platform';
import { PRIMARY_STARTERS, type ArchitectureStarter, type StarterId } from '../../starters';
import { fileOf, useEditorStore, viewLevel } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { ownerAt, viewOf } from '../../depth/tree';
import { looksLikeSystemOverview } from '../../depth/level';
import { displayNameFor } from '../../document/factory';
import { StarterTile } from '../Library/StarterTile';
import { prefersReducedMotion } from '../../lib/motion';

interface EmptyStateProps {
  /** Runs the palette's own starter command — see `EditorScreen`. */
  onInsertStarter: (id: StarterId) => void;
}

/** How long the layer lingers after the canvas stops being empty, matching `canvas.css`. */
const EXIT_MS = 170;

/** Pairs, so the starters stay a composition rather than a strip of icons. */
const ROWS = PRIMARY_STARTERS.reduce<ArchitectureStarter[][]>((rows, starter, i) => {
  if (i % 2 === 0) rows.push([]);
  rows[rows.length - 1]!.push(starter);
  return rows;
}, []);

/**
 * The zero-element canvas: what to press on the left, the primary starters on the right as the
 * topologies they will draw. The same five the home screen offers, so the two surfaces cannot
 * drift, and no browser behind them — the rest of the catalog is a name away in the palette.
 *
 * The starters are the argument this file used to have with itself. They were plain text on the
 * grounds that thumbnails would turn a blank canvas into a template picker — a real risk, and the
 * answer is curation rather than refusing to draw. Five suggestions is not a gallery.
 *
 * `StarterTile` is the home screen's, unchanged but for the patch of dot grid behind each drawing,
 * which `canvas.css` turns off: here they sit on the real canvas, which is the better version of
 * that effect and the reason they read as drawings on the page rather than controls above it.
 *
 * Only the starters take pointer events; everything else is `aria-hidden` decoration over a canvas
 * that must stay double-clickable everywhere else.
 */
export function EmptyState({ onInsertStarter }: EmptyStateProps) {
  const empty = useEditorStore((state) => isCanvasEmpty(state.document));
  const mode = useEditorStore((state) => state.mode);
  const visible = empty && mode === 'edit';
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
  return (
    <>
      <div className="dc-empty" data-leaving={leaving ? 'true' : undefined}>
        <span className="dc-empty-crops" aria-hidden="true">
          <span data-at="nw" />
          <span data-at="ne" />
          <span data-at="se" />
          <span data-at="sw" />
        </span>

        <div className="dc-empty-stage">
          <div className="dc-empty-start" aria-hidden="true">
            <p className="dc-empty-title">Start drawing.</p>
            <p className="dc-empty-hint">Double-click anywhere, or use the toolbar.</p>
            <p className="dc-empty-keys">
              <span className="dc-empty-key">
                <kbd>N</kbd> note
              </span>
              <span className="dc-empty-key">
                <kbd>C</kbd> code
              </span>
              <span className="dc-empty-key">
                <kbd>S</kbd> service
              </span>
              <span className="dc-empty-key">
                <kbd>{MOD_SYMBOL}</kbd>
                <kbd>K</kbd> commands
              </span>
              <span className="dc-empty-key">
                <kbd>?</kbd> shortcuts
              </span>
            </p>
          </div>

          <div className="dc-empty-pick">
            <p className="dc-empty-pick-label" aria-hidden="true">
              Or start from an architecture
            </p>
            <div className="dc-empty-rows" role="group" aria-label="Suggested starters">
              {ROWS.map((row, i) => (
                <div key={i} className="dc-empty-row">
                  {row.map((starter, j) => (
                    <StarterTile
                      key={starter.id}
                      starter={starter}
                      index={i * 2 + j}
                      onStart={onInsertStarter}
                    />
                  ))}
                </div>
              ))}
            </div>
            <p className="dc-empty-more" aria-hidden="true">
              More in the palette: <kbd>{MOD_SYMBOL}</kbd>
              <kbd>K</kbd>, then a name
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
