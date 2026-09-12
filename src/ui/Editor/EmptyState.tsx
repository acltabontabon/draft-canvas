import { useEffect, useRef, useState } from 'react';
import { isCanvasEmpty } from '../../document/operations';
import { MOD_SYMBOL } from '../../lib/platform';
import { FEATURED_STARTERS, type ArchitectureStarter, type StarterId } from '../../starters';
import { useEditorStore } from '../../store/editorStore';
import { Wire } from '../common/Wire';
import { useWireGeometry } from '../common/wireGeometry';
import { StarterTile } from '../Library/StarterTile';
import { StarterBrowser } from './StarterBrowser';

interface EmptyStateProps {
  /** Runs the palette's own starter command — see `EditorScreen`. */
  onInsertStarter: (id: StarterId) => void;
}

/** How long the layer lingers after the canvas stops being empty, matching `canvas.css`. */
const EXIT_MS = 170;

/** Guarded the way `ThemeProvider` guards it — `matchMedia` is missing outside a real browser. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Pairs, so the starters stay a composition rather than a strip of icons. */
const ROWS = FEATURED_STARTERS.reduce<ArchitectureStarter[][]>((rows, starter, i) => {
  if (i % 2 === 0) rows.push([]);
  rows[rows.length - 1]!.push(starter);
  return rows;
}, []);

/**
 * The zero-element canvas, drawn as the smallest diagram that explains itself — the home screen's
 * own composition, one step quieter. A start block on the left, a connector captioned "or cheat a
 * little" through the gutter, four starters on the right as the topologies they will draw.
 *
 * The starters are the argument this file used to have with itself. They were plain text on the
 * grounds that thumbnails would turn a blank canvas into a template picker — a real risk, and the
 * answer is curation rather than refusing to draw. Four suggestions and a quiet "browse all" is
 * not a gallery; the ten names in a bar that stood here before were closer to a catalogue than this
 * is.
 *
 * `StarterTile` is the home screen's, unchanged but for the patch of dot grid behind each drawing,
 * which `canvas.css` turns off: here they sit on the real canvas, which is the better version of
 * that effect and the reason they read as drawings on the page rather than controls above it.
 *
 * Only the starters and the browse link take pointer events; everything else is `aria-hidden`
 * decoration over a canvas that must stay double-clickable everywhere else.
 */
export function EmptyState({ onInsertStarter }: EmptyStateProps) {
  const empty = useEditorStore((state) => isCanvasEmpty(state.document));
  const mode = useEditorStore((state) => state.mode);
  const visible = empty && mode === 'edit';

  /*
   * The arrival plays once, for the canvas someone just opened — never again. Both flags settle
   * in one effect because both are driven by the store rather than by anything a user did here:
   * `introSpent` latches the first time content exists, so emptying a canvas that had work in it
   * brings the layer back in silence; `lingering` holds it on screen for one fade after that.
   */
  const [introSpent, setIntroSpent] = useState(false);
  const [lingering, setLingering] = useState(false);
  const wasVisible = useRef(visible);

  /* oxlint-disable react/set-state-in-effect -- what changed is a store transition, not an event
     this component handled, so there is no earlier place to derive either flag from. */
  useEffect(() => {
    const left = wasVisible.current && !visible;
    wasVisible.current = visible;
    if (visible) return;
    // Latches even on a canvas that was never empty (one opened with work in it), so emptying
    // that canvas later brings the layer back without an arrival.
    setIntroSpent(true);
    // But only something that was actually on screen has anything to fade out — mounting into
    // a full canvas, or into present mode, must not fade in a layer nobody saw.
    if (!left || prefersReducedMotion()) return;
    setLingering(true);
    const timer = setTimeout(() => setLingering(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  /* oxlint-enable react/set-state-in-effect */

  const mounted = visible || lingering;
  if (!mounted) return null;
  // A separate component, so the wire's measuring effect mounts and unmounts with the thing it
  // measures — a hook up here would run once, against refs that were null at the time.
  return <EmptyCanvas onInsertStarter={onInsertStarter} intro={!introSpent} leaving={!visible} />;
}

function EmptyCanvas({
  onInsertStarter,
  intro,
  leaving,
}: EmptyStateProps & { intro: boolean; leaving: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const wireRef = useRef<HTMLDivElement>(null);
  const wire = useWireGeometry(stageRef, wireRef, startRef, '.dc-empty-row');
  const [browsing, setBrowsing] = useState(false);

  return (
    <>
      <div className="dc-empty" data-intro={intro ? 'true' : undefined} data-leaving={leaving ? 'true' : undefined}>
        <span className="dc-empty-crops" aria-hidden="true">
          <span data-at="nw" />
          <span data-at="ne" />
          <span data-at="se" />
          <span data-at="sw" />
        </span>

        <div className="dc-empty-stage" ref={stageRef}>
          <div className="dc-empty-start" ref={startRef} aria-hidden="true">
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

          <div className="dc-empty-wire" ref={wireRef} aria-hidden="true">
            {wire && <Wire geometry={wire} caption="or cheat a little" />}
          </div>

          <p className="dc-empty-cheat" aria-hidden="true">
            <span>or cheat a little</span>
          </p>

          <div className="dc-empty-pick">
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
            <button type="button" className="dc-empty-browse" onClick={() => setBrowsing(true)}>
              Browse all starters
              <span aria-hidden="true"> →</span>
            </button>
          </div>
        </div>

      </div>

      {/* Deliberately a sibling of `.dc-empty`, not a child: that layer is `pointer-events: none`
          so the canvas stays usable through it, and a dialog rendered inside it inherits that and
          becomes uncloseable — nothing in it, close button included, would ever see a click. */}
      {browsing && <StarterBrowser onStart={onInsertStarter} onClose={() => setBrowsing(false)} />}
    </>
  );
}
