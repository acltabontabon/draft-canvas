/** `1 step`, `3 steps` — for the regular English nouns the UI counts. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
