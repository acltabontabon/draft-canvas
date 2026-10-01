/**
 * Opening an image that carries its diagram — an SVG or PNG exported with "Editable" on (see
 * `export/editable.ts`). The Library's import and the drop paths call this before giving up on a
 * file that is not a `.draftcanvas`: `null` means the file is a plain picture with nothing inside,
 * and the caller carries on as it would have; a result means the file claimed a diagram, parsed or
 * not, and the usual import (`NormalizeResult`) takes it from there.
 */

import { LIMITS } from '../document/limits';
import type { NormalizeResult } from '../document/validate';
import { readDocumentFromPng, readDocumentFromSvg } from '../export/editable';
import { readImportText } from '../export/project';

function looksLikeSvg(file: File): boolean {
  return file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
}

function looksLikePng(file: File): boolean {
  return file.type === 'image/png' || /\.png$/i.test(file.name);
}

/** Whether `readEditableImage` would even look at this file — for a drop zone deciding what to accept. */
export function isEditableImageCandidate(file: File): boolean {
  return looksLikeSvg(file) || looksLikePng(file);
}

export async function readEditableImage(file: File): Promise<NormalizeResult | null> {
  if (looksLikeSvg(file)) {
    const read = await readImportText(file);
    return read.ok ? readDocumentFromSvg(read.text) : read;
  }
  if (looksLikePng(file)) {
    if (file.size > LIMITS.maxFileBytes) return null;
    try {
      return readDocumentFromPng(new Uint8Array(await file.arrayBuffer()));
    } catch {
      return null;
    }
  }
  return null;
}
