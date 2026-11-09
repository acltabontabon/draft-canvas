/**
 * Use in docs where the app can't write beside a file — the web app, or a desktop canvas that has no
 * file yet: one ZIP holding the picture and its editable source in a `diagrams/` folder, so the
 * Markdown it offers (`![Payments](diagrams/payments.svg)`) is true the moment the archive is
 * unpacked next to the Markdown file. Nothing is uploaded and nothing is linked; it is a snapshot.
 */

import type { DraftDocument } from '../../document/types';
import { withEmbeddedBackground } from '../background';
import { downloadBlob } from '../download';
import { fileNameFor, serializeDocument } from '../project';
import { zipFiles } from '../zip';
import { renderDocsImage } from './image';
import type { DocsSettings } from './marker';

export const BUNDLE_FOLDER = 'diagrams';

/** The names the archive uses, from the diagram's title: `payments.svg`, `payments.draftcanvas`. */
export function bundleNames(file: DraftDocument): { image: string; source: string; archive: string; imagePath: string } {
  const image = fileNameFor(file.metadata.title, '.svg');
  const source = fileNameFor(file.metadata.title);
  return { image, source, archive: fileNameFor(file.metadata.title, '-docs.zip'), imagePath: `${BUNDLE_FOLDER}/${image}` };
}

/** The archive's bytes. A snapshot: `sync` means nothing without a file to watch, so it is written off. */
export async function docsBundle(file: DraftDocument, settings: DocsSettings): Promise<Uint8Array<ArrayBuffer>> {
  const names = bundleNames(file);
  const rendered = await renderDocsImage(file, names.source, { ...settings, sync: false });
  if (!rendered.ok) throw new Error('The level this image shows no longer exists.');
  const source = serializeDocument(await withEmbeddedBackground(file));
  return zipFiles([
    { name: `${BUNDLE_FOLDER}/${names.image}`, data: rendered.svg },
    { name: `${BUNDLE_FOLDER}/${names.source}`, data: source },
  ]);
}

export async function downloadDocsBundle(file: DraftDocument, settings: DocsSettings): Promise<void> {
  const bytes = await docsBundle(file, settings);
  await downloadBlob(new Blob([bytes], { type: 'application/zip' }), bundleNames(file).archive);
}
