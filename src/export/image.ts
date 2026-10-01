/**
 * The one way an image of a document is produced, whether it is going to a file (`index.ts`) or
 * to the clipboard (`clipboard.ts`): the same SVG from the same renderer, the same rasterization,
 * the same embedded document when the image is editable. Two call sites, one picture.
 */

import type { DraftDocument } from '../document/types';
import { rasterizeSvg } from '../render/png/rasterize';
import { renderDocumentSvg, type ExportOptions } from '../render/svg/document';
import { themeFor } from '../render/theme/tokens';
import { resolveExportBackground } from './background';
import { withDocumentChunk, withDocumentMetadata } from './editable';

export interface ImageExportOptions extends ExportOptions {
  /**
   * The document to carry inside the image, when it should open again as a diagram — normally the
   * whole file, the way a `.draftcanvas` export carries it, whatever room the picture shows. Absent
   * is a plain picture.
   */
  editable?: DraftDocument;
}

export interface PngExportOptions extends ImageExportOptions {
  scale?: number;
}

export async function renderSvgText(document: DraftDocument, options: ImageExportOptions = {}): Promise<string> {
  const background = await resolveExportBackground(document, options.includeBackground !== false);
  const { svg } = renderDocumentSvg(document, { ...options, background });
  return options.editable ? withDocumentMetadata(svg, options.editable) : svg;
}

export async function renderPngBlob(document: DraftDocument, options: PngExportOptions = {}): Promise<Blob> {
  const background = await resolveExportBackground(document, options.includeBackground !== false);
  const rendered = renderDocumentSvg(document, { ...options, background });
  const blob = await rasterizeSvg(rendered.svg, {
    width: rendered.width,
    height: rendered.height,
    scale: options.scale ?? 2,
    background: options.transparent ? undefined : themeFor(options.theme ?? 'dark').canvas,
  });
  if (!options.editable) return blob;
  const stamped = withDocumentChunk(new Uint8Array(await blob.arrayBuffer()), options.editable);
  return new Blob([stamped], { type: 'image/png' });
}
