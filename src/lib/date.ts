/**
 * Human release dates for product-facing UI — an ISO string like "2026-09-10" reads as internal
 * metadata, not something to show someone reading what changed. `'long'` gives "September 10,
 * 2026" (a release's own header, where there's room); the default `'short'` gives "Sep 10, 2026"
 * for compact rows. `formatReleaseDateCompact` drops the year entirely for a dense list already
 * grouped by year.
 */
function parse(iso: string): Date | null {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatReleaseDate(iso: string, style: 'short' | 'long' = 'short'): string {
  const date = parse(iso);
  if (!date) return iso;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: style, day: 'numeric' });
}

export function formatReleaseDateCompact(iso: string): string {
  const date = parse(iso);
  if (!date) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
