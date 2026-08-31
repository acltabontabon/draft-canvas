import type { PersonalityPreset } from '../../ui/personality/usePersonality';

export interface PresetAmplitude {
  /** Corner/vertex jitter magnitude, in canvas units. 0 = no change from Clean. */
  outline: number;
  /** 1 = a single stroke; 2 = an extra faint second stroke (connectors only). */
  strokes: 1 | 2;
}

export const PRESET_AMPLITUDE: Record<PersonalityPreset, PresetAmplitude> = {
  clean: { outline: 0, strokes: 1 },
  draft: { outline: 1.2, strokes: 1 },
  sketch: { outline: 2.5, strokes: 2 },
};
