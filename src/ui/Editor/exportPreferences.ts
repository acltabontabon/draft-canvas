/**
 * The Export dialog's remembered choices that something outside the dialog also reads: the command
 * palette's "Copy as image"/"Copy as SVG" embed the diagram exactly when the dialog's "Editable"
 * box for that format would be ticked, and "Copy source as…" offers every format the Source panel
 * does. One reader per key, so the two can't disagree about a default.
 */

import { isSourceFormat, type SourceFormat } from '../../export';
import { readPreference, writePreference } from '../../lib/preferences';
import type { ImageFormat } from './exportTypes';

export const SOURCE_FORMAT_PREFERENCE = 'sequence-export-format';

const EDITABLE_PREFERENCE: Record<ImageFormat, string> = { svg: 'export-editable-svg', png: 'export-editable-png' };

/** On by default for SVG, where the text costs nothing beside the markup; off for PNG. */
const EDITABLE_DEFAULT: Record<ImageFormat, boolean> = { svg: true, png: false };

export function readEditableImagePreference(format: ImageFormat): boolean {
  const value = readPreference(EDITABLE_PREFERENCE[format]);
  return value === 'on' ? true : value === 'off' ? false : EDITABLE_DEFAULT[format];
}

export function writeEditableImagePreference(format: ImageFormat, on: boolean): void {
  writePreference(EDITABLE_PREFERENCE[format], on ? 'on' : 'off');
}

/** The key has held `mermaid`/`plantuml` since the first sequence export; the newer ids join them. */
export function readSourceFormatPreference(): SourceFormat {
  const value = readPreference(SOURCE_FORMAT_PREFERENCE);
  return isSourceFormat(value) ? value : 'mermaid';
}

export function writeSourceFormatPreference(format: SourceFormat): void {
  writePreference(SOURCE_FORMAT_PREFERENCE, format);
}
