/**
 * Human-readable, collision-safe Mermaid/PlantUML identifiers for sequence participants — e.g.
 * `PaymentService`, `PaymentService2` on a second collision — rather than leaking the internal
 * `P1`/`P2` machine keys into generated source. See `SequenceParticipant.alias`.
 */

/** Mermaid/PlantUML keywords that would break parsing (or spec-legibility) if used as a bare,
 *  unquoted alias — checked case-insensitively. */
const RESERVED_ALIASES = new Set([
  'participant',
  'actor',
  'database',
  'queue',
  'boundary',
  'control',
  'entity',
  'collections',
  'note',
  'end',
  'alt',
  'else',
  'opt',
  'loop',
  'par',
  'and',
  'box',
  'group',
  'critical',
  'break',
  'rect',
  'activate',
  'deactivate',
  'destroy',
  'return',
  'over',
  'left',
  'right',
  'of',
  'as',
]);

const MAX_ALIAS_LENGTH = 40;

/** `label` -> a slug: split on non-alphanumeric runs, title-case each word (an all-caps word like
 *  "API" is preserved as-is, never mangled to "Api"), join with no separator. */
function slugify(label: string): string {
  const words = label.match(/[A-Za-z0-9]+/g) ?? [];
  return words
    .map((w) => (w === w.toUpperCase() ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join('')
    .slice(0, MAX_ALIAS_LENGTH);
}

/**
 * A readable, collision-safe Mermaid/PlantUML identifier for a participant — `PaymentService`,
 * `PaymentService2` on a second collision. Falls back to `fallback` (the participant's own stable
 * `id`, e.g. `P3`) when the label has no usable alphanumeric characters, the slug starts with a
 * digit, or it collides case-insensitively with a reserved word.
 */
export function aliasFor(label: string, fallback: string, taken: ReadonlySet<string>): string {
  const base = slugify(label);
  const safe = base && !/^[0-9]/.test(base) && !RESERVED_ALIASES.has(base.toLowerCase()) ? base : fallback;
  if (!taken.has(safe)) return safe;
  for (let n = 2; ; n += 1) {
    const candidate = `${safe}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
