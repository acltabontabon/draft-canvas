/**
 * A Mermaid flowchart, read (`parse.ts`) and laid out as a Draft Canvas document.
 *
 * The layout is the agent's own `compose` — the same code an MCP `create_diagram` runs — reached
 * through a dynamic import so the layout engine stays its own chunk: the parser is a few kilobytes
 * and runs on every paste sniff, the engine is not and runs only once a flowchart is actually there.
 * `compose` is synchronous and bounded by its deadline; a large chart holds the main thread for at
 * most that long, which an import (one deliberate act, with a notice to follow) can afford where the
 * agent's streaming preview could not.
 */

import { createId } from '../../document/ids';
import type { DraftDocument } from '../../document/types';
import { deserializeDocument, serializeDocument } from '../../export/project';
import { createDocument, createNode } from '../../document/factory';
import { describeContext, naturalSequenceSizeFor } from '../../nodes/describe';
import { LIGHT } from '../../render/theme/tokens';
import { cleanTitle } from '../../document/sanitize';
import { parseMermaidFlowchart } from './parse';
import { logDiagnostic } from '../../lib/diagnostics';
import { parseMermaidSequence, UNTITLED_SEQUENCE } from './sequence';
import { DEFAULT_IMPORT_TITLE, looksLikeMermaidSequence } from './sniff';

export { looksLikeMermaid, parseMermaidFlowchart, MERMAID_LIMITS } from './parse';

export type ImportResult =
  | { ok: true; document: DraftDocument; unsupported: string[]; legibility: unknown }
  | { ok: false; error: string };

/** How long one import may spend repairing a layout before it settles for what it has. */
export const IMPORT_DEADLINE_MS = 8_000;

/**
 * Turns flowchart text into a document. `title` names the document when the text itself does not
 * (a Mermaid `title:` front-matter line wins — it was written on purpose; a file name was not).
 */
export async function importMermaid(text: string, title?: string): Promise<ImportResult> {
  if (looksLikeMermaidSequence(text)) return importMermaidSequence(text, title);
  const parsed = parseMermaidFlowchart(text);
  if (!parsed.ok) return parsed;
  const create = title && parsed.create.title === DEFAULT_IMPORT_TITLE ? { ...parsed.create, title: cleanTitle(title, DEFAULT_IMPORT_TITLE) } : parsed.create;
  const { compose } = await import('../../agent/compile');
  let composed: { text: string; receipt: Record<string, unknown> };
  try {
    composed = compose(create, createId('d'), { deadline: performance.now() + IMPORT_DEADLINE_MS });
  } catch (error) {
    logDiagnostic(error, { operation: 'import-mermaid' });
    return { ok: false, error: plainImportError(error) };
  }
  // Exactly how the desktop shell reads what `compose` made (`desktop/agent.ts`): the composed text
  // is a `.draftcanvas` file, and the file reader is the one path every document enters by.
  const read = deserializeDocument(composed.text);
  if (!read.ok) return { ok: false, error: PLAIN_FAILED };
  return { ok: true, document: read.document, unsupported: parsed.unsupported, legibility: composed.receipt.legibility };
}

const PLAIN_FAILED = 'That flowchart couldn’t be turned into a diagram. Try splitting it into smaller flowcharts.';

/**
 * What a failed layout says to the person who pasted a flowchart. `compose` is the agent's, so its
 * errors are written for one — ids, JSON pointers ("/relationships/1: …"), "the composed diagram
 * would be altered on its next open" — and none of that means anything here. The kind of failure
 * is kept; the vocabulary is not. The full error goes to the diagnostics log.
 */
function plainImportError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  switch (code) {
    case 'LAYOUT_FAILED':
      return 'That flowchart couldn’t be arranged into a readable diagram. Try shorter labels, or split it into smaller flowcharts.';
    case 'CANCELLED':
      return 'Arranging that flowchart took too long. Try splitting it into smaller flowcharts.';
    default:
      return PLAIN_FAILED;
  }
}

/**
 * A sequence diagram becomes one sequence on the canvas, the size of what it holds. Nothing is laid
 * out here beyond that: a sequence lays itself out, so the text's order is the picture's.
 */
function importMermaidSequence(text: string, title?: string): ImportResult {
  const parsed = parseMermaidSequence(text);
  if (!parsed.ok) return parsed;
  const name = cleanTitle(title && parsed.title === UNTITLED_SEQUENCE ? title : parsed.title, UNTITLED_SEQUENCE);
  const bare = { ...createNode({ type: 'sequence', x: 0, y: 0, text: name }), sequence: parsed.sequence };
  const node = { ...bare, ...naturalSequenceSizeFor(bare, describeContext(LIGHT)) };
  // Through the file reader, like every other document: what an import makes is checked the same way a file is.
  const read = deserializeDocument(serializeDocument({ ...createDocument(name), nodes: [node] }));
  if (!read.ok) return { ok: false, error: 'That sequence diagram couldn’t be turned into a diagram.' };
  return { ok: true, document: read.document, unsupported: parsed.unsupported, legibility: undefined };
}
