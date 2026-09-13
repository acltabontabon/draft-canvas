import { useEffect, useState } from 'react';
import { logDiagnostic } from '../../lib/diagnostics';
import { loadStarters, loadedStarters, type StartersModule } from '../../starters/load';

/** The starter catalog, or `null` for the moment its chunk is still arriving — see `starters/load`. */
export function useStarters(): StartersModule | null {
  const [starters, setStarters] = useState(loadedStarters);
  useEffect(() => {
    if (starters) return;
    let cancelled = false;
    loadStarters().then(
      (module) => {
        if (!cancelled) setStarters(module);
      },
      // The shelf simply stays empty; the next mount (or starter action) fetches again.
      (error: unknown) => logDiagnostic(error, { operation: 'load-starters' }),
    );
    return () => {
      cancelled = true;
    };
  }, [starters]);
  return starters;
}
