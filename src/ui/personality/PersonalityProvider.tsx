import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readPreference, writePreference } from '../../lib/preferences';
import { PERSONALITY_PRESETS, PersonalityContext, type PersonalityPreset } from './usePersonality';

const STORAGE_KEY = 'personality';

function initialPreset(): PersonalityPreset {
  const stored = readPreference(STORAGE_KEY);
  return (PERSONALITY_PRESETS as readonly string[]).includes(stored ?? '')
    ? (stored as PersonalityPreset)
    : 'clean';
}

/**
 * A global device preference, like `ThemeProvider` — not part of the document
 * model. A diagram's "sketchiness" is how this device likes to look at
 * canvases, not a property of the file itself.
 */
export function PersonalityProvider({ children }: { children: ReactNode }) {
  const [preset, setPresetState] = useState<PersonalityPreset>(initialPreset);

  useEffect(() => {
    writePreference(STORAGE_KEY, preset);
  }, [preset]);

  const setPreset = useCallback((next: PersonalityPreset) => setPresetState(next), []);
  const value = useMemo(() => ({ preset, setPreset }), [preset, setPreset]);

  return <PersonalityContext value={value}>{children}</PersonalityContext>;
}
