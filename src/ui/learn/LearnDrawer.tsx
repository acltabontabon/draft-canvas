import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { usePopoverPresence } from '../../canvas/usePopoverPresence';
import { isImeKeyEvent } from '../../lib/isEditableTarget';
import { recipeById } from '../../learn/recipes';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../common/Icon';
import { trapTab } from '../common/focusTrap';
import { LearnHome } from './LearnHome';
import { LearnRecipe } from './LearnRecipe';
import './learn.css';

/** Must match `.dc-learn[data-closing]`'s animation in `learn.css`. */
const EXIT_MS = 160;

/**
 * Below this width there isn't room to dock beside the canvas without crushing it, so Learn becomes
 * a sheet over it instead — modal, with its own scrim and focus trap. `data-mode` carries the
 * answer to `learn.css`, so this is the only place the width is written down.
 */
const SHEET_QUERY = '(max-width: 1179px)';

function sheetQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(SHEET_QUERY) : null;
}

function subscribeSheet(onChange: () => void): () => void {
  const query = sheetQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const readSheet = () => sheetQuery()?.matches ?? false;

/**
 * Learn Draft Canvas: a field guide you pull open while you work, answer one question in, and close.
 *
 * Docked beside the canvas on a wide window — the canvas narrows but stays fully live, nothing is
 * hidden under it — and a sheet over the canvas on a narrow one. It isn't a mode: nothing in the
 * editor changes while it's open, and it remembers where you were only for the session.
 *
 * Loaded on first open (it and every scene are their own chunk), then kept mounted by the editor.
 */
export function LearnDrawer() {
  const open = useUiStore((state) => state.learnOpen);
  // Presenting owns the whole screen; Learn steps aside and comes back after.
  const presenting = useEditorStore((state) => state.mode === 'present');
  const { mounted, closing } = usePopoverPresence(open && !presenting, EXIT_MS);
  const sheet = useSyncExternalStore(subscribeSheet, readSheet, () => false);
  if (!mounted) return null;
  return <LearnPanel closing={closing} sheet={sheet} />;
}

function LearnPanel({ closing, sheet }: { closing: boolean; sheet: boolean }) {
  const recipeId = useUiStore((state) => state.learnRecipeId);
  const focusRequest = useUiStore((state) => state.learnFocusRequest);
  const query = useUiStore((state) => state.learnQuery);
  const closeLearn = useUiStore((state) => state.closeLearn);
  const showLearnRecipe = useUiStore((state) => state.showLearnRecipe);
  const setLearnQuery = useUiStore((state) => state.setLearnQuery);
  // An id that no longer names a recipe (renamed since) is simply home.
  const recipe = recipeById(recipeId);

  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Whatever had focus when Learn opened gets it back on close — but only if focus is still in
  // Learn by then. A docked drawer stays open while you work on the canvas, and closing it must not
  // yank focus away from wherever you've since gone.
  const [returnFocusTo] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    if (!closing) return;
    const active = document.activeElement;
    const inside = !active || active === document.body || panelRef.current?.contains(active);
    if (inside && returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus();
  }, [closing, returnFocusTo]);

  // Coming back from a recipe is a step back, not an arrival: home plays only its back motion.
  const [shownId, setShownId] = useState(recipe?.id ?? null);
  const [returning, setReturning] = useState(false);
  if ((recipe?.id ?? null) !== shownId) {
    setReturning(!recipe);
    setShownId(recipe?.id ?? null);
  }

  // Focus moves only when asked to: an explicit open (`openLearn`), or navigating between home and a
  // recipe. A drawer that merely remounts — after a presentation, or on the next document with Learn
  // still docked — leaves focus on the canvas, where the next keystroke is meant to land.
  const shownRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (closing) return;
    const current = recipe?.id ?? null;
    const previous = shownRef.current;
    shownRef.current = current;
    const navigated = previous !== undefined && previous !== current;
    const requested = useUiStore.getState().takeLearnFocus();
    if (!navigated && !requested) return;
    if (recipe) {
      headingRef.current?.focus({ preventScroll: true });
      return;
    }
    // Going back lands on the row you came from, not at the top of the list.
    const row = navigated && previous ? panelRef.current?.querySelector<HTMLElement>(`[data-recipe-id="${previous}"]`) : null;
    (row ?? searchRef.current)?.focus({ preventScroll: Boolean(row) });
    // Re-runs on navigation and on every explicit open request — not on each keystroke.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe?.id, focusRequest]);

  // As a sheet, Learn holds Tab like any modal — at the window, so a Tab taken while focus has
  // fallen to the page (the control that held it unmounted) still comes back in. A dialog opened on
  // top (the shortcut sheet) runs its own trap.
  useEffect(() => {
    if (!sheet) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!panelRef.current || document.querySelector('[aria-modal="true"]:not(.dc-learn)')) return;
      trapTab(event, panelRef.current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [sheet]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || isImeKeyEvent(event)) return;
    // Learn's Escape steps back one level at a time — the same way Escape steps back everywhere else.
    event.preventDefault();
    event.stopPropagation();
    if (recipe) showLearnRecipe(null);
    else if (query) {
      setLearnQuery('');
      searchRef.current?.focus();
    } else closeLearn();
  };

  return (
    <>
      {sheet && <div className="dc-learn-scrim" data-closing={closing ? 'true' : undefined} onPointerDown={closeLearn} />}
      <aside
        ref={panelRef}
        className="dc-learn"
        data-mode={sheet ? 'sheet' : 'dock'}
        data-closing={closing ? 'true' : undefined}
        data-dc-keyboard-region=""
        role={sheet ? 'dialog' : 'complementary'}
        aria-modal={sheet ? true : undefined}
        aria-labelledby="dc-learn-title"
        onKeyDown={onKeyDown}
      >
        <header className="dc-learn-header">
          <span className="dc-learn-mark" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <rect x="1.5" y="5.5" width="7" height="9" rx="2" />
              <rect x="12.5" y="2.5" width="6" height="6" rx="1.6" />
              <rect x="12.5" y="11.5" width="6" height="6" rx="1.6" />
              <path d="M8.5 10h2M10.5 10V5.5h2M10.5 10v4.5h2" />
            </svg>
          </span>
          <h2 id="dc-learn-title" className="dc-learn-title">
            Learn <span>Draft Canvas</span>
          </h2>
          <button type="button" className="dc-learn-close" onClick={closeLearn} aria-label="Close Learn">
            <Icon name="close" size={14} />
          </button>
        </header>

        {recipe ? (
          <LearnRecipe key={recipe.id} recipe={recipe} headingRef={headingRef} onBack={() => showLearnRecipe(null)} onOpen={showLearnRecipe} />
        ) : (
          <LearnHome searchRef={searchRef} returning={returning} onOpen={showLearnRecipe} />
        )}
      </aside>
    </>
  );
}
