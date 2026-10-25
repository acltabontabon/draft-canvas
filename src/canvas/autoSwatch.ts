import { ACCENTS } from '../document/types';
import type { Theme } from '../render/theme/tokens';

const cache = new WeakMap<object, string>();

/** The same palette wheel wherever an automatic colour can be overridden. */
export function autoSwatch(theme: Pick<Theme, 'accents'>): string {
  let swatch = cache.get(theme.accents);
  if (!swatch) {
    const chips = ACCENTS.filter((accent) => accent !== 'neutral').map((accent) => theme.accents[accent].chip);
    swatch = `conic-gradient(${chips.map((chip, index) => `${chip} ${(index * 100) / chips.length}% ${((index + 1) * 100) / chips.length}%`).join(', ')})`;
    cache.set(theme.accents, swatch);
  }
  return swatch;
}
