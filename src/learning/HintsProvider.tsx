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
 */
export function HintsProvider({ children }: { children: ReactNode }) {
  const [retired, setRetired] = useState<ReadonlySet<HintId>>(initialRetired);

  const retire = useCallback((id: HintId) => {
    setRetired((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    writePreference(`hint.${id}`, '1');
  }, []);

  const isRetired = useCallback((id: HintId) => retired.has(id), [retired]);

  const value = useMemo(() => ({ isRetired, retire }), [isRetired, retire]);

  return <HintsContext value={value}>{children}</HintsContext>;
}
