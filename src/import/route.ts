/**
 * One decision for every way a file reaches Draft Canvas — the Library's Import button, a drop on
 * the Library, a drop on the canvas: what kind of file it is, and the reader that opens it. The
 * entry points share this so a format added here arrives everywhere at once.
 *
 * Extension first, content second: a `.json` that reads as a flowchart is one (people save Mermaid
 * under any name), and a `.draftcanvas` is read by the document reader whatever it holds.
 */

import type { NormalizeResult } from '../document/validate';
import { deserializeDocument, readImportText, readProjectFile } from '../export/project';
import { looksLikeSecureExport } from '../export/secureProject';
import { readEditableImage } from './editableImage';
import { looksLikeMermaid } from './mermaid/parse';

export type RoutedImport =
  /** An encrypted export: it needs a passphrase, which only the Library's prompt can ask for. */
  | { kind: 'secure' }
  | { kind: 'document'; result: NormalizeResult; unsupported?: string[] };

/** Every extension the file picker offers; a drop accepts the same set. */
export const IMPORT_ACCEPT = '.draftcanvas,.json,application/json,.dcenc,.mmd,.mermaid,.md,text/markdown,.svg,image/svg+xml,.png,image/png';

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

/** A document's title from the file it came in: the name without its extension. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return base || 'Imported diagram';
}

export async function routeImportFile(file: File): Promise<RoutedImport> {
  if (await looksLikeSecureExport(file)) return { kind: 'secure' };
  const extension = extensionOf(file.name);
  if (extension === 'svg' || extension === 'png' || file.type === 'image/svg+xml' || file.type === 'image/png') {
    const result = await readEditableImage(file);
    return { kind: 'document', result: result ?? { ok: false, error: `${file.name} is a picture, not an editable export: Draft Canvas reads the diagram an SVG or PNG it exported itself carries.` } };
  }
  if (extension === 'mmd' || extension === 'mermaid' || extension === 'md') return mermaidFile(file);
  if (extension === 'draftcanvas') return { kind: 'document', result: await readProjectFile(file) };
  // `.json`, `.txt`, no extension: the content decides.
  const read = await readImportText(file);
  if (!read.ok) return { kind: 'document', result: read };
  if (looksLikeMermaid(read.text)) return mermaidText(read.text, file.name);
  return { kind: 'document', result: deserializeDocument(read.text) };
}

async function mermaidFile(file: File): Promise<RoutedImport> {
  const read = await readImportText(file);
  if (!read.ok) return { kind: 'document', result: read };
  return mermaidText(read.text, file.name);
}

async function mermaidText(text: string, fileName: string): Promise<RoutedImport> {
  const { importMermaid } = await import('./mermaid');
  const imported = await importMermaid(text, titleFromFileName(fileName));
  if (!imported.ok) return { kind: 'document', result: imported };
  return { kind: 'document', result: { ok: true, document: imported.document, repairs: [] }, unsupported: imported.unsupported };
}

/** The one notice shown before an imported flowchart opens, naming what Mermaid said that was not drawn. */
export function unsupportedNotice(unsupported: readonly string[]): string | null {
  if (unsupported.length === 0) return null;
  const shown = unsupported.slice(0, 4).join(', ');
  const more = unsupported.length > 4 ? `, and ${unsupported.length - 4} more` : '';
  return `Imported — ${unsupported.length} thing${unsupported.length === 1 ? '' : 's'} Mermaid said that Draft Canvas doesn't draw: ${shown}${more}.`;
}
