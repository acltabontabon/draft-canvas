import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readPreference, writePreference } from '../../lib/preferences';
import { PERSONALITY_PRESETS, PersonalityContext, type PersonalityPreset } from '../../theme/usePersonality';
import { useStyleStore } from '../../store/styleStore';

const STORAGE_KEY = 'personality';

function initialPreset(): PersonalityPreset {
  const stored = readPreference(STORAGE_KEY);
  return (PERSONALITY_PRESETS as readonly string[]).includes(stored ?? '')
    ? (stored as PersonalityPreset)
    : 'clean';
}

/**
 * A device preference, like `ThemeProvider`: the drawing hand this device likes to look at
 * canvases in. A diagram with no style of its own is drawn in it; one that carries a style
 * (`DraftDocument.style`) is drawn in that, here and everywhere else.
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

  // The person's own styles are read once, as the app starts: a diagram made before Settings was
  // ever opened must still start with the style in use, not with a built-in one.
  useEffect(() => {
    void useStyleStore.getState().load();
  }, []);

  const setPreset = useCallback((next: PersonalityPreset) => setPresetState(next), []);
  const value = useMemo(() => ({ preset, setPreset }), [preset, setPreset]);

  return <PersonalityContext value={value}>{children}</PersonalityContext>;
}
