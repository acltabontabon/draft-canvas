/**
 * `gifenc` ships no type declarations — this is the minimal surface Draft
 * Canvas actually calls (see `src/export/gif.ts`), not a full port of its API.
 */
declare module 'gifenc' {
  export type RgbColor = [number, number, number];
  export type RgbaColor = [number, number, number, number];
  export type GifPalette = RgbColor[] | RgbaColor[];
  export type GifPixelFormat = 'rgb565' | 'rgb444' | 'rgba4444';

  export interface QuantizeOptions {
    format?: GifPixelFormat;
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): GifPalette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: GifPixelFormat,
  ): Uint8Array;

  export interface WriteFrameOptions {
    palette?: GifPalette;
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    /** Frame delay in milliseconds. */
    delay?: number;
    /** -1 = play once, 0 = loop forever, >0 = extra repeat count. */
    repeat?: number;
    dispose?: number;
  }

  export interface GifEncoderInstance {
    writeHeader(): void;
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
    readonly buffer: ArrayBuffer;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance;
}
