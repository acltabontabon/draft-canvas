import { PATH_CAP, type PathCount } from '../traffic';

/** "999+" past the cap, where counting stopped. */
function amount(value: number): string {
  return value >= PATH_CAP ? `${PATH_CAP}+` : String(value);
}

/**
 * Modeled paths in words, shared by the canvas badge and the traffic panel so the two always say
 * the same thing. A range keeps the uncertainty the diagram leaves — "2–4 paths": two certain, up
 * to two more across a split nobody drew the share of — rather than picking a number inside it.
 */
export function pathsLabel(paths: PathCount): string {
  const { definite, possible } = paths;
  const noun = possible === 1 ? 'path' : 'paths';
  if (possible === 0) return 'no paths';
  if (definite === possible) return `${amount(definite)} ${noun}`;
  if (definite === 0) return `up to ${amount(possible)} ${noun}`;
  return `${amount(definite)}–${amount(possible)} ${noun}`;
}
