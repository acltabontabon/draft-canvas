/**
 * Turns a copied fragment into a portable string, and back.
 *
 * Deliberately reuses the whole-document model rather than a parallel
 * clipboard schema: `encodeClipboard` wraps the fragment in an otherwise
 * ordinary `DraftDocument`, and `decodeClipboard` reads it back through the
 * same untrusted-input boundary every `.draftcanvas` file already passes
 * through (`parseDocument` — JSON parsing, format/version check, migration,
 * repair-don't-reject sanitization). That gets "a versioned format that can
 * evolve safely" for free from `CURRENT_VERSION`/`migrate.ts`, with no new
 * validation code, at the cost of a slightly heavier payload than a bespoke
 * fragment schema would be — a fine trade for a JSON string this small.
 *
 * Kept out of `operations.ts` on purpose: that module is pure document
 * transforms with no JSON/serialization dependency, and stays that way.
 */
import { createDocument } from './factory';
import { parseDocument } from './validate';
import type { Clipboard } from './operations';

export function encodeClipboard(fragment: Clipboard): string {
  const envelope = { ...createDocument(), nodes: fragment.nodes, edges: fragment.edges };
  return JSON.stringify(envelope);
}

/** `null` for anything that isn't a Draft Canvas payload — an empty/foreign
 *  system clipboard is a normal, silent no-op for paste, never an error. */
export function decodeClipboard(text: string): Clipboard | null {
  if (!text) return null;
  const result = parseDocument(text);
  if (!result.ok) return null;
  return { nodes: result.document.nodes, edges: result.document.edges };
}
