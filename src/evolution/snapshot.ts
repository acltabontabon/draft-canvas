/**
 * A revision's bytes, and the way back to a document.
 *
 * A revision stores exactly one file, `diagram.draftcanvas`, holding the canonical serialization
 * (`export/canonical.ts`) of the file's history content (`document/content.ts`). So:
 *
 * - equal history content ⇔ equal bytes ⇔ equal blob id — capture never needs a second opinion;
 * - `git show main:diagram.draftcanvas > copy.draftcanvas` opens in Draft Canvas as it is;
 * - old revisions are never rewritten when the format moves on: reading one migrates it in memory
 *   through `parseDocument`, exactly as opening an old file does.
 */
import { historyContent } from '../document/content';
import type { DraftDocument } from '../document/types';
import { parseDocument } from '../document/validate';
import { serializeDocument } from '../export/project';
import { HistoryError } from './contracts';

/** The canonical text a revision of `file` stores. */
export function historyText(file: DraftDocument): string {
  return serializeDocument(historyContent(file));
}

/**
 * A revision's text as a document, validated like any file. A revision that no longer opens (cut
 * short, or from a build newer than this one) is reported, never repaired into something else.
 */
export function readHistoryText(text: string): { document: DraftDocument; repaired: boolean } {
  const result = parseDocument(text);
  if (!result.ok) {
    throw new HistoryError(result.reason === 'newer' ? 'unsupported-format' : 'corrupt', result.error);
  }
  return { document: result.document, repaired: result.repairs.length > 0 };
}
