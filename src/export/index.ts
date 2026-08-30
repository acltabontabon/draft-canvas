import type { DraftDocument } from '../document/types';
import { rasterizeSvg } from '../render/png/rasterize';
import { renderDocumentSvg, type ExportOptions } from '../render/svg/document';
import { themeFor } from '../render/theme/tokens';
import { downloadBlob, downloadText } from './download';
import { FILE_MIME, fileNameFor, serializeDocument } from './project';

export * from './project';
export * from './secureProject';
export { downloadBlob, downloadText } from './download';

export function exportProjectFile(document: DraftDocument): void {
  downloadText(serializeDocument(document), fileNameFor(document.metadata.title), FILE_MIME);
}

export function exportSvgFile(document: DraftDocument, options: ExportOptions = {}): void {
  const { svg } = renderDocumentSvg(document, options);
  downloadText(svg, fileNameFor(document.metadata.title, '.svg'), 'image/svg+xml');
}

export async function exportPngFile(
  document: DraftDocument,
  options: ExportOptions & { scale?: number } = {},
): Promise<void> {
  const rendered = renderDocumentSvg(document, options);
  const blob = await rasterizeSvg(rendered.svg, {
    width: rendered.width,
    height: rendered.height,
    scale: options.scale ?? 2,
    background: options.transparent ? undefined : themeFor(options.theme ?? 'dark').canvas,
  });
  downloadBlob(blob, fileNameFor(document.metadata.title, '.png'));
}
