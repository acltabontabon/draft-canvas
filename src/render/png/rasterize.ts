/**
 * PNG output is produced by rasterizing the very same SVG string that the SVG
 * export writes. One renderer, two file formats — a PNG can never disagree with
 * its SVG twin, and there is no second code path to keep in step.
 */
class RasterizeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RasterizeError';
    this.cause = cause;
  }
}

export interface RasterizeOptions {
  width: number;
  height: number;
  /** Fixed multiplier, deliberately not devicePixelRatio: exports must be reproducible. */
  scale?: number;
  background?: string;
}

async function drawSvgToCanvas(svg: string, options: RasterizeOptions): Promise<HTMLCanvasElement> {
  const scale = options.scale ?? 1;
  const width = Math.max(1, Math.round(options.width * scale));
  const height = Math.max(1, Math.round(options.height * scale));

  const image = await loadSvgImage(svg);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new RasterizeError('This browser did not provide a 2D canvas context.');

  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

export async function rasterizeSvg(
  svg: string,
  options: RasterizeOptions,
): Promise<Blob> {
  const canvas = await drawSvgToCanvas(svg, { ...options, scale: options.scale ?? 2 });

  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new RasterizeError('The browser could not encode the image.'));
      }, 'image/png');
    } catch (error) {
      // Older Safari can taint a canvas that has had an SVG drawn into it.
      reject(new RasterizeError('This browser refused to export the image.', error));
    }
  });
}

export interface RasterizedPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Same rasterization `rasterizeSvg` uses, but returns raw RGBA pixels instead
 * of an encoded PNG — what the Phase 4.3 GIF exporter feeds to `gifenc`'s
 * quantizer one frame at a time.
 */
export async function rasterizeSvgToPixels(
  svg: string,
  options: RasterizeOptions,
): Promise<RasterizedPixels> {
  const canvas = await drawSvgToCanvas(svg, options);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new RasterizeError('This browser did not provide a 2D canvas context.');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height };
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  // A blob URL avoids the size ceiling and the escaping pitfalls of data URIs.
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'sync';
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      // Almost always malformed XML reaching the parser — hence the aggressive
      // escaping and control-character stripping in the emitter.
      reject(new RasterizeError('The generated image could not be read back by the browser.'));
    };
    image.src = url;
  });
}
