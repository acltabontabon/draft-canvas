/**
 * The air a fit leaves around what it frames, as React Flow 13 takes it.
 *
 * Every fit here states its padding the way React Flow 12 read a bare number: the content is given
 * `1 / (1 + ratio)` of the view, and the rest is split between the two sides. React Flow 13 reads a
 * bare number as pixels, so `0.2` became no air at all. This says the same amount as a share of the
 * view, which both versions read alike.
 */
export function fitPadding(ratio: number): `${number}%` {
  return `${(ratio / (1 + ratio)) * 50}%`;
}
