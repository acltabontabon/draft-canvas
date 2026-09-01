import { useEffect } from 'react';
import { HINT_COPY, type HintId } from '../learning/hints';
import { useHints } from '../learning/useHints';
import { useUiStore } from '../store/uiStore';

/**
 * A one-line, dismissible explanation folded into the top of whichever contextual popover
 * selecting the element already opens (Phase 7.1) — never a second floating box anchored beside
 * the one that just appeared.
 *
 * `learned` is the caller's own "this behavior was just demonstrated" signal (Phase 7.2) — e.g.
 * "does any node or edge already carry an attachment?" — kept as a derived boolean the caller
 * computes from state it already has, rather than this component reaching into the document
 * itself, so one small primitive covers every hint regardless of what teaches it.
 */
export function HintStrip({ id, learned }: { id: HintId; learned: boolean }) {
  const { isRetired, retire } = useHints();
  const learnModeActive = useUiStore((state) => state.learnModeActive);

  useEffect(() => {
    if (learned) retire(id);
  }, [learned, id, retire]);

  if (learned) return null;
  if (isRetired(id) && !learnModeActive) return null;

  return (
    <div className="dc-hint-strip">
      <span>{HINT_COPY[id]}</span>
      <button
        type="button"
        className="dc-hint-strip-close"
        aria-label="Dismiss hint"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          retire(id);
        }}
      >
        ×
      </button>
    </div>
  );
}
