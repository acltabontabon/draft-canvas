import type { DraftDocument } from '../document/types';
import { rasterizeSvg } from '../render/png/rasterize';
import { renderDocumentSvg, type ExportOptions } from '../render/svg/document';
import { themeFor } from '../render/theme/tokens';
import { resolveExportBackground } from './background';
import { downloadBlob, downloadText } from './download';
import { FILE_MIME, fileNameFor, serializeDocument } from './project';

export * from './project';
export * from './secureProject';
export * from './gif';
export { downloadBlob, downloadText } from './download';
export { resolveExportBackground } from './background';

export function exportProjectFile(document: DraftDocument): void {
  downloadText(serializeDocument(document), fileNameFor(document.metadata.title), FILE_MIME);
}

export async function exportSvgFile(document: DraftDocument, options: ExportOptions = {}): Promise<void> {
  const background = await resolveExportBackground(document, options.includeBackground !== false);
  const { svg } = renderDocumentSvg(document, { ...options, background });
  downloadText(svg, fileNameFor(document.metadata.title, '.svg'), 'image/svg+xml');
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
  downloadBlob(blob, fileNameFor(document.metadata.title, '.png'));
}
