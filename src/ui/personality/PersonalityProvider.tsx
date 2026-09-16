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
    // Also on the document, so the chrome drawn in CSS rather than by the renderer can follow the
    // drawing style. Without it a hand-drawn canvas carried perfectly crisp rectangles for the one
    // shape holding something — the only square corner on screen, on the one thing meant to blend
    // in. `ThemeProvider` already publishes the theme the same way.
    globalThis.document?.documentElement.setAttribute('data-personality', preset);
  }, [preset]);

  const setPreset = useCallback((next: PersonalityPreset) => setPresetState(next), []);
  const value = useMemo(() => ({ preset, setPreset }), [preset, setPreset]);

  return <PersonalityContext value={value}>{children}</PersonalityContext>;
}
