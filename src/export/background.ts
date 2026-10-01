import { LIMITS } from '../document/limits';
import type { DraftDocument, EmbeddedBackgroundImage } from '../document/types';
import { base64ToBlob } from '../lib/base64';
import type { ResolvedBackground } from '../render/svg/document';
import { getRepository, type DraftRepository } from '../storage';

/** The largest background a `.draftcanvas` export carries with it — see `EmbeddedBackgroundImage`. */
export const MAX_EMBEDDED_BACKGROUND_BYTES = LIMITS.maxEmbeddedBackgroundBytes;

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the background image.'));
    reader.readAsDataURL(blob);
  });
}

/** The stored image behind a document's background, if the document has one turned on. */
async function storedBackground(document: DraftDocument): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (!document.settings.background.enabled) return null;
  const repository = await getRepository();
  return repository.loadBackgroundImage(document.metadata.id, document.settings.background.imageId);
}

/**
 * Loads a document's configured background (if any) and base64-encodes it,
 * so the SVG renderer downstream (`renderDocumentSvg`) stays a synchronous,
 * pure function with no storage access of its own.
 */
export async function resolveExportBackground(
  document: DraftDocument,
  includeBackground: boolean,
): Promise<ResolvedBackground | undefined> {
  if (!includeBackground) return undefined;
  const row = await storedBackground(document);
  if (!row) return undefined;

  const dataUri = await blobToDataUri(row.blob);
  const { fit, dim, blur } = document.settings.background;
  return { dataUri, fit, dim, blur, naturalWidth: row.width, naturalHeight: row.height };
}

/**
 * Whether a `.draftcanvas` export of this document carries its background: `'embedded'` when the
 * image is small enough to travel, `'too-large'` when there is one but it stays behind, `'none'`
 * when the canvas shows no background (or its image is missing from the store, which the canvas
 * already treats as none).
 */
export async function backgroundTravels(document: DraftDocument): Promise<'embedded' | 'too-large' | 'none'> {
  const row = await storedBackground(document);
  if (!row) return 'none';
  return row.blob.size <= MAX_EMBEDDED_BACKGROUND_BYTES ? 'embedded' : 'too-large';
}

/**
 * The document as a `.draftcanvas` file should carry it: with its background image inline when
 * there is one and it is small enough (`backgroundTravels`), untouched otherwise. Never the
 * document the store holds — the image is a property of the file, not of the canvas.
 */
export async function withEmbeddedBackground(document: DraftDocument): Promise<DraftDocument> {
  const row = await storedBackground(document);
  if (!row || row.blob.size > MAX_EMBEDDED_BACKGROUND_BYTES) return document;
  const image: EmbeddedBackgroundImage = { dataUri: await blobToDataUri(row.blob), width: row.width, height: row.height };
  return { ...document, settings: { ...document.settings, background: { ...document.settings.background, image } } };
}

/**
 * The reverse of `withEmbeddedBackground`, for a file that arrived with its image inline: the
 * bytes go into the image store under the document's id (and `imageId`, so the canvas finds them
 * exactly as it finds a background chosen here), and the returned document no longer carries them
 * — what is saved to IndexedDB must hold the image once, in its own store, never twice.
 *
 * Storing the image comes first, so a document is never saved pointing at bytes that failed to
 * land: if the store refuses them, the caller's own save is what fails.
 */
export async function adoptEmbeddedBackground(document: DraftDocument, repository: DraftRepository): Promise<DraftDocument> {
  const { image, ...background } = document.settings.background;
  if (!image) return document;
  const stripped: DraftDocument = { ...document, settings: { ...document.settings, background } };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.dataUri);
  // `validate.ts` only lets a well-formed data URI through; anything else means the document was
  // built by hand, and "no image" is the honest reading of it.
  if (!match) return stripped;
  await repository.saveBackgroundImage(
    document.metadata.id,
    base64ToBlob(match[2]!, match[1]!),
    { width: image.width, height: image.height },
    background.imageId,
  );
  return stripped;
}
