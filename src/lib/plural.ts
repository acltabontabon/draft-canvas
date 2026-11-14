/** `1 step`, `3 steps` — for the regular English nouns the UI counts. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** What a selection holds, in the words the canvas uses: "2 shapes", "1 connector", and — when it is
 *  both, so neither word covers it — the umbrella "3 elements". */
export function selectionCount(shapes: number, connectors: number): string {
  if (connectors === 0) return count(shapes, 'shape');
  if (shapes === 0) return count(connectors, 'connector');
  return count(shapes + connectors, 'element');
}
