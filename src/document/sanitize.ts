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

/** What a diagram is called until its owner says otherwise, and when what they typed is nothing. */
export const DEFAULT_TITLE = 'Untitled diagram';

/** Cuts at `max` without leaving half of a surrogate pair (an emoji) at the end. */
function cutAt(value: string, max: number): string {
  if (value.length <= max) return value;
  const high = value.charCodeAt(max - 1);
  return value.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

/**
 * The one rule for a diagram's title, wherever it comes from — typed, renamed, loaded, imported,
 * duplicated, received from a collaborator: control characters dropped, trimmed, then cut to
 * `LIMITS.maxTitleLength` (leading space never costs a letter, and the cut never ends in a space or
 * mid-emoji), and `fallback` when nothing is left. The paths used to disagree on all of that, so a
 * title one of them accepted another rewrote on the next open.
 */
export function cleanTitle(value: string, fallback: string = DEFAULT_TITLE): string {
  const title = cutAt(value.replace(CONTROL_CHARS, '').trim(), LIMITS.maxTitleLength).trimEnd();
  return title || fallback;
}

/**
 * The text fields that are read as a line of words rather than as written, kept one way whoever
 * writes them (the inspector, a patch, a file, an agent): control characters out, cut to the limit,
 * trimmed — and nothing left means the field is not there (`undefined`), never an empty string
 * that still reserves a line. A technology is one line, so runs of whitespace become one space.
 */
export function cleanEdgeLabel(value: string): string | undefined {
  return cleanText(value, LIMITS.maxLabelLength).trim() || undefined;
}

export function cleanTechnology(value: string): string | undefined {
  return cleanText(value, LIMITS.maxTechnologyLength).replace(/\s+/g, ' ').trim() || undefined;
}

export function cleanDescription(value: string): string | undefined {
  return cleanText(value, LIMITS.maxDescriptionLength).trim() || undefined;
}

/** `title` with `suffix` after it, the title giving way (not the suffix) when the two together are too long. */
export function titleWithSuffix(title: string, suffix: string): string {
  const base = cleanTitle(title);
  if (base.length + suffix.length <= LIMITS.maxTitleLength) return `${base}${suffix}`;
  return `${cutAt(base, LIMITS.maxTitleLength - suffix.length).trimEnd()}${suffix}`;
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
  cadence: LIMITS.maxCadenceLength,
  response: LIMITS.maxResponseLength,
  compensationName: LIMITS.maxCompensationNameLength,
  compensationDescription: LIMITS.maxDescriptionLength,
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
