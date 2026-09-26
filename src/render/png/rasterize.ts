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

/** Beyond these, browsers refuse to allocate a canvas — or quietly hand back a blank one. */
const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_AREA = 100_000_000;
/** Below this the text stops being readable, so the export fails with advice instead. */
const MIN_FITTED_SCALE = 0.5;

/**
 * The requested scale, reduced just enough for the canvas to fit the browser's limits. Still a pure
 * function of the diagram's size, so an export stays reproducible.
 */
function fittedScale(width: number, height: number, scale: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return Math.min(scale, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
}

async function drawSvgToCanvas(svg: string, options: RasterizeOptions): Promise<HTMLCanvasElement> {
  const scale = fittedScale(options.width, options.height, options.scale ?? 1);
  if (scale < Math.min(MIN_FITTED_SCALE, options.scale ?? 1)) {
    throw new RasterizeError('The diagram is too spread out for an image this size. Try SVG, or export a selection.');
  }
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
