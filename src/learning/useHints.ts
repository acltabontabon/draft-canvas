import { createContext, useContext } from 'react';
import type { HintId } from './hints';

export interface HintsContextValue {
  isRetired: (id: HintId) => boolean;
  retire: (id: HintId) => void;
}

// Retired by default: if a component somehow renders outside `HintsProvider`, the safe failure
// mode is "show nothing," never "show every hint."
export const HintsContext = createContext<HintsContextValue>({
  isRetired: () => true,
  retire: () => {},
});

export function useHints(): HintsContextValue {
  return useContext(HintsContext);
}
