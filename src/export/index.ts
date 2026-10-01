import type { DraftDocument } from '../document/types';
import { rasterizeSvg } from '../render/png/rasterize';
import { renderDocumentSvg, type ExportOptions } from '../render/svg/document';
import { themeFor } from '../render/theme/tokens';
import { resolveExportBackground, withEmbeddedBackground } from './background';
import { downloadBlob, downloadText } from './download';
import { LEVELS_EXTENSION, zipEveryLevel, type EveryLevelOptions } from './levels';
import { FILE_MIME, fileNameFor, serializeDocument } from './project';

export * from './project';
export * from './secureProject';
export * from './sequence';
export { collectLevels, LEVELS_EXTENSION, type EveryLevelOptions, type LevelImageFormat } from './levels';
export { hasRooms } from './rooms';
export { backgroundTravels } from './background';

/** The document as a `.draftcanvas` file, its background image inside it when one travels (`backgroundTravels`). */
export async function exportProjectFile(document: DraftDocument): Promise<void> {
  const file = await withEmbeddedBackground(document);
  await downloadText(serializeDocument(file), fileNameFor(document.metadata.title), FILE_MIME);
}

export async function exportSvgFile(document: DraftDocument, options: ExportOptions = {}): Promise<void> {
  const background = await resolveExportBackground(document, options.includeBackground !== false);
  const { svg } = renderDocumentSvg(document, { ...options, background });
  await downloadText(svg, fileNameFor(document.metadata.title, '.svg'), 'image/svg+xml');
}

export async function exportPngFile(
  document: DraftDocument,
  options: ExportOptions & { scale?: number } = {},
): Promise<void> {
  const background = await resolveExportBackground(document, options.includeBackground !== false);
  const rendered = renderDocumentSvg(document, { ...options, background });
  const blob = await rasterizeSvg(rendered.svg, {
    width: rendered.width,
    height: rendered.height,
    scale: options.scale ?? 2,
    background: options.transparent ? undefined : themeFor(options.theme ?? 'dark').canvas,
  });
  await downloadBlob(blob, fileNameFor(document.metadata.title, '.png'));
}

/** One image per room — the root and every level below it — in a single ZIP. */
export async function exportEveryLevel(document: DraftDocument, options: EveryLevelOptions): Promise<void> {
  const background = await resolveExportBackground(document, options.includeBackground !== false);
  const bytes = await zipEveryLevel(document, { ...options, background });
  await downloadBlob(new Blob([bytes], { type: 'application/zip' }), fileNameFor(document.metadata.title, LEVELS_EXTENSION));
}
