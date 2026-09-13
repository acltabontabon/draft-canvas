/**
 * The longest side a stored canvas background keeps. Every SVG export and every GIF frame embeds
 * the image, so a photo straight off a phone would make those slow and memory-hungry for detail no
 * canvas ever shows.
 */
export const MAX_BACKGROUND_SIDE = 4096;

/** `width × height` scaled down (never up) so neither side exceeds `max`, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const ratio = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/**
 * A chosen image file, ready to store as a background: the file itself when it is already small
 * enough, otherwise a downscaled copy. JPEG and WebP stay lossy; anything else becomes PNG so
 * transparency survives. Rejects when the file isn't a decodable image.
 */
export async function prepareBackgroundImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    const target = fitWithin(width, height, MAX_BACKGROUND_SIDE);
    if (target.width === width && target.height === height) return { blob: file, width, height };

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas context to resize the image with.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const type = file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png';
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('The resized image could not be encoded.'))), type, 0.9);
    });
    return { blob, ...target };
  } finally {
    bitmap.close();
  }
}
