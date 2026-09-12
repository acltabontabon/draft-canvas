import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { HintId } from './hints';
import { HintsContext } from './useHints';

/**
 * Which hints have been dismissed — or just demonstrated (`HintStrip`'s "learned" effect) — this
 * session. Hints only ever show while Learn mode is on, and a Learn pass is a deliberate review, so
 * nothing here is persisted: a fresh session resurfaces every hint the next time Learn mode is
 * turned on. Within a session, a dismissal wins immediately and stays won — otherwise the X button
 * would look broken.
 */
export function HintsProvider({ children }: { children: ReactNode }) {
  const [sessionDismissed, setSessionDismissed] = useState<ReadonlySet<HintId>>(() => new Set());

  const retire = useCallback((id: HintId) => {
    setSessionDismissed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const isDismissedThisSession = useCallback((id: HintId) => sessionDismissed.has(id), [sessionDismissed]);

  const value = useMemo(() => ({ isDismissedThisSession, retire }), [isDismissedThisSession, retire]);

  return <HintsContext value={value}>{children}</HintsContext>;
}
