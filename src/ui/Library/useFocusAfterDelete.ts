import { useCallback, useLayoutEffect, useRef } from 'react';

interface Waiting {
  id: string;
  index: number;
  /** The delete has finished, one way or the other. */
  settled: boolean;
}

/**
 * Moves focus once a deleted diagram's card has left the list: to whatever `landing` finds at the
 * place the card held. Shared by Home's shelf and the gallery, which lose the same thing: the
 * trash button that opened the confirmation, gone with its card.
 *
 * It used to be a `requestAnimationFrame` after `deleteDocument` resolved, focusing only if nothing
 * had focus. That raced two things it could not see. `deleteDocument` resolving means the new list
 * has been *handed* to React, not drawn: the commit is a task of its own, and a frame served before
 * that task found the deleted card still on the page. And by then the closing dialog had usually
 * handed focus back to that card's trash button, so the "nothing has focus" test said no; the card
 * then left with focus inside it, which fell to `<body>` for good. Seen as a Home shelf journey
 * that failed once in a while on Firefox in CI, where a busy runner serves the frame first.
 *
 * So this waits for what it actually depends on, the list without the deleted diagram, and acts in
 * that commit's layout effect: the card is out of the DOM, and focus that was inside it has already
 * fallen away. Anything still focused then is something the person chose since, and keeps it.
 */
export function useFocusAfterDelete(
  library: readonly { id: string }[],
  landing: (index: number) => HTMLElement | null | undefined,
): (id: string, index: number, deletion: Promise<unknown>) => void {
  const waiting = useRef<Waiting | null>(null);
  const currentLanding = useRef(landing);
  useLayoutEffect(() => {
    currentLanding.current = landing;
  });

  useLayoutEffect(() => {
    const entry = waiting.current;
    if (!entry) return;
    if (library.some((item) => item.id === entry.id)) {
      // Still listed after the delete finished: it failed (and said so), and the dialog's own
      // focus return stands. Forgotten here so a later, unrelated removal does not move focus.
      if (entry.settled) waiting.current = null;
      return;
    }
    waiting.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    currentLanding.current(entry.index)?.focus();
  }, [library]);

  return useCallback((id, index, deletion) => {
    const entry: Waiting = { id, index, settled: false };
    waiting.current = entry;
    const settle = () => {
      entry.settled = true;
    };
    void deletion.then(settle, settle);
  }, []);
}
