import { canonicalStyle, normalizeStyle, STYLE_LIMITS, type DocumentStyle } from './style';
import { cleanText } from './sanitize';
import { isRecord } from '../lib/isRecord';

/**
 * A style as a file of its own (`.draftstyle`): what "Export style" writes, what "Import style"
 * reads, and what a gallery style pack is.
 *
 * Plain JSON like a diagram, for the same reasons: it can be read, diffed and kept in a
 * repository. It holds a style and nothing else, so it carries nothing about any diagram or about
 * the device it came from. Whatever is read back is checked exactly like a style in a diagram
 * (`normalizeStyle`): a style file is untrusted input.
 */

export const STYLE_FILE_FORMAT = 'draft-canvas-style' as const;
export const STYLE_FILE_VERSION = 1;
export const STYLE_FILE_EXTENSION = '.draftstyle';
export const STYLE_FILE_MIME = 'application/json';

/** A style with every drawing a style may hold is a few hundred kilobytes; anything past this is not a style. */
export const MAX_STYLE_FILE_BYTES = 1_048_576;

export function serializeStyleFile(name: string, style: DocumentStyle): string {
  const label = cleanText(name, STYLE_LIMITS.maxNameLength).trim() || 'My style';
  const checked = canonicalStyle({ ...style, name: label }) ?? { v: 1, name: label, hand: { base: 'clean' } };
  return `${JSON.stringify({ format: STYLE_FILE_FORMAT, version: STYLE_FILE_VERSION, name: label, style: checked }, null, 2)}\n`;
}

/** What the file is called: the style's name, made safe for a file system. */
export function styleFileName(name: string): string {
  const base = name
    .trim()
    .replace(/[^\p{L}\p{N}._ -]+/gu, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return `${base || 'style'}${STYLE_FILE_EXTENSION}`;
}

export type StyleFileResult = { ok: true; name: string; style: DocumentStyle; repairs: string[] } | { ok: false; error: string };

export function readStyleFile(text: string): StyleFileResult {
  if (typeof text !== 'string' || text.length > MAX_STYLE_FILE_BYTES) return { ok: false, error: 'That file is too large to be a style.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file isn’t a Draft Canvas style.' };
  }
  if (!isRecord(raw) || raw.format !== STYLE_FILE_FORMAT) return { ok: false, error: 'That file isn’t a Draft Canvas style.' };
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, error: 'That file isn’t a Draft Canvas style.' };
  if (raw.version > STYLE_FILE_VERSION) return { ok: false, error: 'That style was made by a newer Draft Canvas. Update to use it.' };
  const { style, repairs } = normalizeStyle(raw.style);
  if (!style) return { ok: false, error: 'That file has no style in it that can be read.' };
  const name = (typeof raw.name === 'string' ? cleanText(raw.name, STYLE_LIMITS.maxNameLength).trim() : '') || style.name || 'Imported style';
  return { ok: true, name, style: { ...style, name }, repairs };
}
