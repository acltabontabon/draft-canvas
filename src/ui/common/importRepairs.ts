/**
 * The toast for a file imported with real repairs, or null when there is nothing to say.
 *
 * Bringing an older file up to this version's format is no repair: `parseDocument` lists it with
 * the repairs ("Upgraded document format from v25 to v34."), so every valid older export said
 * "Imported with repairs" and looked damaged, while the same diagram opened from the Library said
 * nothing (`IndexedDbRepository` leaves the line out the same way).
 */
export function importRepairsNotice(repairs: readonly string[]): string | null {
  const real = repairs.filter((line) => !line.startsWith('Upgraded document format'));
  return real.length > 0 ? `Imported with repairs: ${real.join(' ')}` : null;
}
