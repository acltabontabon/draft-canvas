import type { DraftDocument } from '../document/types';
import { resolveExportBackground, withEmbeddedBackground } from './background';
import { downloadBlob, downloadText } from './download';
import { renderPngBlob, renderSvgText, type ImageExportOptions, type PngExportOptions } from './image';
import { LEVELS_EXTENSION, zipEveryLevel, type EveryLevelOptions } from './levels';
import { FILE_MIME, fileNameFor, serializeDocument } from './project';

// What the Export dialog reads, named one by one: the modules' other exports are imported from the
// modules themselves, so a barrel import never drags a writer into a graph that didn't ask for it.
export { fileNameFor } from './project';
export { exportSecureProjectFile, SECURE_EXPORT_FILE_EXTENSION } from './secureProject';
export { countPlayableFlows } from './sequence';
export { exportSourceFile, SOURCE_FORMAT_INFO, SOURCE_FORMATS, sourceFileNameFor, sourceTextFor, type SourceFamily, type SourceFormat } from './source';
export { copyImage, copySource, copySvg, type CopyResult } from './clipboard';
export { collectLevels, LEVELS_EXTENSION } from './levels';
export { hasRooms } from './rooms';
export { backgroundTravels } from './background';

/** The document as a `.draftcanvas` file, its background image inside it when one travels (`backgroundTravels`). */
export async function exportProjectFile(document: DraftDocument): Promise<void> {
  const file = await withEmbeddedBackground(document);
  await downloadText(serializeDocument(file), fileNameFor(document.metadata.title), FILE_MIME);
}

export async function exportSvgFile(document: DraftDocument, options: ImageExportOptions = {}): Promise<void> {
  const svg = await renderSvgText(document, options);
  await downloadText(svg, fileNameFor(document.metadata.title, '.svg'), 'image/svg+xml');
}

export async function exportPngFile(document: DraftDocument, options: PngExportOptions = {}): Promise<void> {
  const blob = await renderPngBlob(document, options);
  await downloadBlob(blob, fileNameFor(document.metadata.title, '.png'));
}

/** One image per room — the root and every level below it — in a single ZIP. */
export async function exportEveryLevel(document: DraftDocument, options: EveryLevelOptions): Promise<void> {
  const background = await resolveExportBackground(document, options.includeBackground !== false);
  const bytes = await zipEveryLevel(document, { ...options, background });
  await downloadBlob(new Blob([bytes], { type: 'application/zip' }), fileNameFor(document.metadata.title, LEVELS_EXTENSION));
}
