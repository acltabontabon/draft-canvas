import { createContext, useContext } from 'react';
import type { HintId } from './hints';

export interface HintsContextValue {
  isDismissedThisSession: (id: HintId) => boolean;
  retire: (id: HintId) => void;
}

// Dismissed by default: if a component somehow renders outside `HintsProvider`, the safe failure
// mode is "show nothing," never "show every hint."
export const HintsContext = createContext<HintsContextValue>({
  isDismissedThisSession: () => true,
  retire: () => {},
});

export function useHints(): HintsContextValue {
  return useContext(HintsContext);
}
