import { useCallback, useState } from 'react';
import { prefersReducedMotion } from '../../lib/motion';

interface Keyed {
  key: string;
}

interface Shown<T> {
  /** The subject as it was when its key arrived — what a departing callout keeps showing. */
  subject: T | null;
  leaving: T | null;
}

/**
 * The callout shown now, plus at most one on its way out — derived from the subject's identity,
 * not driven by timers.
 *
 * When the key changes, whatever was showing becomes `leaving` and plays its exit animation; the
 * caller reports `animationend` through `settle`. A further change replaces `leaving` outright
 * instead of queueing behind it, so holding → through a presentation converges on the step you land
 * on, never on a backlog. Reduced motion keeps nothing leaving: there is no animation to wait for.
 */
export function useCalloutPresence<T extends Keyed>(
  subject: T | null,
): { current: T | null; leaving: T | null; settle: (key: string) => void } {
  const [shown, setShown] = useState<Shown<T>>({ subject, leaving: null });

  let { leaving } = shown;
  if ((subject?.key ?? null) !== (shown.subject?.key ?? null)) {
    // Adjusting state during render (React's documented pattern) — the next render sees it at once.
    leaving = prefersReducedMotion() ? null : shown.subject;
    setShown({ subject, leaving });
  }

  const settle = useCallback((key: string) => {
    setShown((state) => (state.leaving?.key === key ? { ...state, leaving: null } : state));
  }, []);

  return { current: subject, leaving, settle };
}
