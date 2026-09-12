import { useEffect, useRef } from 'react';

/**
 * Captures whatever element has real DOM focus the moment `active` becomes true, and restores
 * focus to it — if it's still attached to the document — the moment `active` goes back to false
 * or the calling component unmounts, whichever comes first. Shared by `Modal`, `CommandPalette` and
 * `ClipboardPermissionDialog` so the dialogs can't drift on this behavior: closing any of them must
 * hand focus back to whatever opened it, not drop it to `<body>`. `active` may be a constant `true`
 * for a component that only mounts while open, or a reactive flag on one that stays mounted.
 *
 * The capture itself has to happen synchronously during render, not inside a `useEffect` (even a
 * layout one): both `Modal` and `CommandPalette` focus something of their own via the `autoFocus`
 * prop, which React applies synchronously while committing the DOM — strictly before any passive
 * *or* layout effect gets a turn, regardless of hook declaration order. An effect here would
 * therefore always observe the dialog's own just-focused content, never what had focus a moment
 * before. Reading `document.activeElement` in the render body instead sees the *pre-commit* DOM —
 * this component's own about-to-open markup hasn't reached the page yet — so it still reflects
 * whatever was genuinely focused beforehand.
 */
export function useFocusReturn(active: boolean) {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Deliberately *not* initialized from `active`: `Modal` passes a constant `true` (it only ever
  // mounts while open, so there's no reactive transition to observe), and this still has to treat
  // that very first render as "just became active" so the capture below actually runs once.
  const wasActive = useRef(false);

  // oxlint-disable react/refs -- deliberate: see the doc comment above for why this has to read
  // and write refs during render rather than in an effect. Safe under StrictMode's double-render
  // too: `wasActive.current` is already flipped `true` by the first of the two calls, so the
  // second is a no-op — both would have observed the same `document.activeElement` regardless,
  // since nothing runs between them, so capturing once (the first) is not observably different
  // from capturing on every call.
  if (active && !wasActive.current) {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasActive.current = active;
  // oxlint-enable react/refs

  // The restoration itself has to live in this effect's *cleanup*, not in a sibling branch that
  // only runs on some later "active is now false" invocation: `Modal`'s `active` is a constant
  // `true` for its whole mounted lifetime (it only ever unmounts, never re-renders with `false`),
  // so a cleanup is the only hook the closing transition actually reaches for it. It works
  // identically for `CommandPalette`'s reactive `active: open` — React runs this same cleanup
  // before the next effect (registered by the render where `open` just became `false`) runs.
  //
  // Deliberately does *not* null `previouslyFocused.current` here (only the render-body capture
  // above ever overwrites it): React 18 StrictMode double-invokes an effect's setup→cleanup→setup
  // once on every mount in development, to simulate an unmount+remount. Nulling the ref in cleanup
  // made that simulated cleanup consume it, leaving the *real* cleanup — the one that runs when
  // this dialog genuinely closes — with nothing left to restore. Re-focusing the same element more
  // than once is harmless; losing the reference to it before the real close isn't.
  useEffect(() => {
    if (!active) return;
    return () => {
      const toRestore = previouslyFocused.current;
      if (toRestore && document.contains(toRestore)) toRestore.focus();
    };
  }, [active]);
}
