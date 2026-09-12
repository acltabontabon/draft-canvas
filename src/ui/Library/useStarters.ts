import { useEffect, useState } from 'react';
import { loadStarters, loadedStarters, type StartersModule } from '../../starters/load';

/** The starter catalog, or `null` for the moment its chunk is still arriving — see `starters/load`. */
export function useStarters(): StartersModule | null {
  const [starters, setStarters] = useState(loadedStarters);
  useEffect(() => {
    if (starters) return;
    let cancelled = false;
    void loadStarters().then((module) => {
      if (!cancelled) setStarters(module);
    });
    return () => {
      cancelled = true;
    };
  }, [starters]);
  return starters;
}
