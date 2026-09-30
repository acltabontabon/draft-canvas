import { LIMITS } from './limits';

/**
 * Control characters have no place in a label and confuse DOM and SVG alike.
 * Tab, newline and carriage return are deliberately kept: code cards
 * legitimately contain them. U+FFFE and U+FFFF are not characters at all, and XML refuses them —
 * one in a label made every SVG and PNG export of the diagram fail while the canvas looked fine.
 */
// oxlint-disable-next-line no-control-regex -- matching them is the point
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g;

/** Strips what `CONTROL_CHARS` names and cuts to `max`. The one rule the importer and the editor share. */
export function cleanText(value: string, max: number): string {
  const cleaned = value.replace(CONTROL_CHARS, '');
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/**
 * The limit each free-text field is held to, wherever it's written — typed into the editor or read
 * from a file. The editor used to take text the loader would cut on the next open, silently: a
 * 250,000-character log pasted into a code card came back shorter, with nothing saying so.
 */
export const TEXT_FIELD_LIMITS = {
  text: LIMITS.maxTextLength,
  code: LIMITS.maxCodeLength,
  description: LIMITS.maxDescriptionLength,
  technology: LIMITS.maxTechnologyLength,
  label: LIMITS.maxLabelLength,
  condition: LIMITS.maxConditionLength,
  response: LIMITS.maxResponseLength,
} as const;

type LimitedField = keyof typeof TEXT_FIELD_LIMITS;

/**
 * A patch with every limited text field cleaned, and whether any was cut short (control characters
 * dropped don't count — nobody meant to type them).
 */
export function cleanTextFields<T extends object>(patch: T): { patch: T; truncated: boolean } {
  let truncated = false;
  let next: T | null = null;
  for (const field of Object.keys(TEXT_FIELD_LIMITS) as LimitedField[]) {
    const value = (patch as Record<string, unknown>)[field];
    if (typeof value !== 'string') continue;
    const max = TEXT_FIELD_LIMITS[field];
    const cleaned = cleanText(value, max);
    if (cleaned === value) continue;
    if (value.replace(CONTROL_CHARS, '').length > max) truncated = true;
    next ??= { ...patch };
    (next as Record<string, unknown>)[field] = cleaned;
  }
  return { patch: next ?? patch, truncated };
}
