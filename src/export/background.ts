import type { DraftDocument } from '../document/types';
import type { ResolvedBackground } from '../render/svg/document';
import { getRepository } from '../storage';

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the background image.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Loads a document's configured background (if any) and base64-encodes it,
 * so every SVG renderer downstream (`renderDocumentSvg`, `renderFlowFrameSvg`)
 * stays a synchronous, pure function with no storage access of its own.
 */
export async function resolveExportBackground(
  document: DraftDocument,
  includeBackground: boolean,
): Promise<ResolvedBackground | undefined> {
  if (!includeBackground || !document.settings.background.enabled) return undefined;
  const repository = await getRepository();
  const row = await repository.loadBackgroundImage(document.metadata.id, document.settings.background.imageId);
  if (!row) return undefined;

  const dataUri = await blobToDataUri(row.blob);
  const { fit, dim, blur } = document.settings.background;
  return { dataUri, fit, dim, blur, naturalWidth: row.width, naturalHeight: row.height };
}
