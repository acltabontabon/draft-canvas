const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
];

/** Built once: a formatter per row per keystroke of search adds up on a long library. */
const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 hours ago", for the lists that say when something was last touched. */
export function relativeTime(at: number): string {
  const delta = at - Date.now();
  const absolute = Math.abs(delta);
  if (absolute < 45_000) return 'just now';

  for (let i = UNITS.length - 1; i >= 0; i -= 1) {
    const [unit, ms] = UNITS[i]!;
    if (absolute >= ms) return RELATIVE_TIME.format(Math.round(delta / ms), unit);
  }
  return 'just now';
}
