import { createContext, useContext } from 'react';

/** Phase 5.2 — Clean is today's exact appearance, byte-for-byte unchanged. */
export const PERSONALITY_PRESETS = ['clean', 'draft', 'sketch'] as const;
export type PersonalityPreset = (typeof PERSONALITY_PRESETS)[number];

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
