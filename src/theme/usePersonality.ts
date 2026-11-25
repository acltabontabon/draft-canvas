import { createContext, useContext } from 'react';
import { HAND_PRESETS, type HandPreset } from '../document/style';

/** The drawing hand this device prefers. A diagram that carries no style of its own follows it. */
export const PERSONALITY_PRESETS = HAND_PRESETS;
export type PersonalityPreset = HandPreset;

export interface PersonalityContextValue {
  preset: PersonalityPreset;
  setPreset: (preset: PersonalityPreset) => void;
}

export const PersonalityContext = createContext<PersonalityContextValue>({
  preset: 'clean',
  setPreset: () => {},
});

export function usePersonality(): PersonalityContextValue {
  return useContext(PersonalityContext);
}
