import { HAND_PRESETS, type HandPreset } from '../document/style';

/**
 * The drawing hand this device prefers, readable outside React for a command that renders a picture
 * the way the screen shows it. `PersonalityProvider` keeps it on the page's root element. Clean
 * when nothing can be asked.
 */
export function deviceHand(): HandPreset {
  const value = typeof document === 'undefined' ? undefined : document.documentElement.dataset.personality;
  return (HAND_PRESETS as readonly string[]).includes(value ?? '') ? (value as HandPreset) : 'clean';
}
