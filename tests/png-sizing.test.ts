import { describe, expect, it } from 'vitest';
import { crc32, physChunk, pixelsPerMetre, withPhysChunk } from '../src/render/png/phys';
import {
  canvasLimitsFor,
  DESKTOP_CANVAS_LIMITS,
  fittedScale,
  IOS_CANVAS_LIMITS,
} from '../src/render/png/rasterize';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  const body = [...ascii(type), ...data];
  return [...u32(data.length), ...body, ...u32(crc32(new Uint8Array(body)))];
}

function bytes(values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(values.length);
  out.set(values);
  return out;
}

/** The smallest PNG shape worth the name: signature, a 1×1 IHDR, an (empty) IDAT and IEND. */
function tinyPng(): Uint8Array<ArrayBuffer> {
  const ihdr = [...u32(1), ...u32(1), 8, 6, 0, 0, 0];
  return bytes([...SIGNATURE, ...chunk('IHDR', ihdr), ...chunk('IDAT', []), ...chunk('IEND', [])]);
}

function readU32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
}

function chunkTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let at = 8;
  while (at < bytes.length) {
    const length = readU32(bytes, at);
    types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    at += 12 + length;
  }
  return types;
}

describe('PNG pHYs chunk', () => {
  it('computes the CRC the PNG spec expects', () => {
    // IEND's CRC is the one constant every PNG ends with.
    expect(crc32(new Uint8Array(ascii('IEND')))).toBe(0xae426082);
    // The 72 dpi pHYs chunk (2835 px/m) that most encoders write, CRC included.
    const body = new Uint8Array([...ascii('pHYs'), ...u32(2835), ...u32(2835), 1]);
    expect(crc32(body)).toBe(0x009a9c18);
  });

  it('derives pixels per metre from 96 dpi times the scale', () => {
    expect(pixelsPerMetre(1)).toBe(3780);
    expect(pixelsPerMetre(2)).toBe(7559);
    expect(pixelsPerMetre(3)).toBe(11339);
  });

  it('inserts a well-formed chunk right after IHDR', () => {
    const out = withPhysChunk(tinyPng(), 2);

    expect(chunkTypes(out)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    const at = 8 + 25; // signature + IHDR
    expect(readU32(out, at)).toBe(9);
    expect(String.fromCharCode(...out.subarray(at + 4, at + 8))).toBe('pHYs');
    expect(readU32(out, at + 8)).toBe(7559);
    expect(readU32(out, at + 12)).toBe(7559);
    expect(out[at + 16]).toBe(1);
    expect(readU32(out, at + 17)).toBe(crc32(out.subarray(at + 4, at + 17)));
    expect(out.length).toBe(tinyPng().length + physChunk(2).length);
  });

  it('is reproducible and leaves the bytes around the chunk untouched', () => {
    const input = tinyPng();
    const a = withPhysChunk(input, 2);
    const b = withPhysChunk(input, 2);
    expect(a).toEqual(b);
    expect(Array.from(a.subarray(0, 33))).toEqual(Array.from(input.subarray(0, 33)));
    expect(Array.from(a.subarray(33 + 21))).toEqual(Array.from(input.subarray(33)));
  });

  it('leaves a non-PNG, or a PNG that already carries a pHYs chunk, alone', () => {
    const notPng = bytes([1, 2, 3]);
    expect(withPhysChunk(notPng, 2)).toBe(notPng);
    const once = withPhysChunk(tinyPng(), 2);
    expect(withPhysChunk(once, 3)).toBe(once);
  });
});

describe('fitted scale', () => {
  it('keeps the chosen scale when the canvas fits', () => {
    expect(fittedScale(1000, 800, 2, DESKTOP_CANVAS_LIMITS)).toBe(2);
    expect(fittedScale(1000, 800, 3, DESKTOP_CANVAS_LIMITS)).toBe(3);
  });

  it('reduces the scale to the desktop area cap', () => {
    // 10,000 × 8,000 at 2× would be 320M pixels; the area cap of 100M allows √(100M / 80M).
    const fitted = fittedScale(10_000, 8_000, 2, DESKTOP_CANVAS_LIMITS);
    expect(fitted).toBeCloseTo(Math.sqrt(100_000_000 / 80_000_000), 6);
    expect(fitted * 10_000 * fitted * 8_000).toBeLessThanOrEqual(100_000_000 + 1);
  });

  it('reduces the scale to the longest side', () => {
    expect(fittedScale(20_000, 100, 2, DESKTOP_CANVAS_LIMITS)).toBeCloseTo(16_384 / 20_000, 6);
  });

  it('fits a much smaller canvas on iOS than on the desktop', () => {
    // 4,000 × 3,000 at 2× is 48M pixels: fine on a desktop, four times the iOS cap.
    expect(fittedScale(4_000, 3_000, 2, DESKTOP_CANVAS_LIMITS)).toBe(2);
    const ios = fittedScale(4_000, 3_000, 2, IOS_CANVAS_LIMITS);
    expect(ios).toBeCloseTo(Math.sqrt((4096 * 4096) / 12_000_000), 6);
    expect(ios * 4_000 * ios * 3_000).toBeLessThanOrEqual(4096 * 4096 + 1);
  });

  it('tells an iPhone, an iPad and a desktop-UA iPad from a Mac', () => {
    expect(canvasLimitsFor({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(IOS_CANVAS_LIMITS);
    expect(canvasLimitsFor({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(IOS_CANVAS_LIMITS);
    expect(canvasLimitsFor({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(IOS_CANVAS_LIMITS);
    expect(canvasLimitsFor({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(DESKTOP_CANVAS_LIMITS);
    expect(canvasLimitsFor({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 10 })).toBe(DESKTOP_CANVAS_LIMITS);
  });
});
