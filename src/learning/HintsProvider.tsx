import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { readPreference, writePreference } from '../lib/preferences';
import { HINT_IDS, type HintId } from './hints';
import { HintsContext } from './useHints';

function initialRetired(): ReadonlySet<HintId> {
  const retired = new Set<HintId>();
  for (const id of HINT_IDS) {
    if (readPreference(`hint.${id}`) === '1') retired.add(id);
  }
  return retired;
}

/**
 * A global device preference, like `PersonalityProvider` — which hints have already fired is a
 * fact about this browser, not this document. Each hint is its own short `hint.<id>` key
 * (`preferences.ts`'s length cap is on the value, not the key, so many small keys is the intended
 * shape here), written the moment a hint retires — by an explicit dismissal or by
 * `HintStrip`'s own "the behavior was just demonstrated" effect (Phase 7.2).
 *
 * `sessionDismissed` is a second, deliberately unpersisted set: "Learn Draft Canvas" mode
 * resurfaces already-retired hints for a deliberate review pass (`HintStrip`'s
 * `isRetired(id) && !learnModeActive` guard), but an explicit dismissal during that pass must
 * still win immediately and stay won for the rest of the session — otherwise the X button looks
 * broken while Learn Mode is on. A fresh session starts this set empty, so retired hints still
 * resurface the next time Learn Mode is turned on later — that's the feature, not a bug.
 */
export function HintsProvider({ children }: { children: ReactNode }) {
  const [retired, setRetired] = useState<ReadonlySet<HintId>>(initialRetired);
  const [sessionDismissed, setSessionDismissed] = useState<ReadonlySet<HintId>>(() => new Set());

  const retire = useCallback((id: HintId) => {
    setRetired((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setSessionDismissed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    writePreference(`hint.${id}`, '1');
  }, []);

  const isRetired = useCallback((id: HintId) => retired.has(id), [retired]);
  const isDismissedThisSession = useCallback((id: HintId) => sessionDismissed.has(id), [sessionDismissed]);

  const value = useMemo(
    () => ({ isRetired, isDismissedThisSession, retire }),
    [isRetired, isDismissedThisSession, retire],
  );

  return <HintsContext value={value}>{children}</HintsContext>;
}
