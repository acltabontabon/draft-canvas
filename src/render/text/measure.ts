import { Lru } from '../../lib/lru';
import { cssFont, type FontSpec } from './fonts';

export interface FontMetrics {
  /** Distance from the top of the line box to the baseline. */
  ascent: number;
  descent: number;
}

export interface TextMeasurer {
  width(text: string, font: FontSpec): number;
  metrics(font: FontSpec): FontMetrics;
  /** Advance width of one character in a monospace font. */
  charWidth(font: FontSpec): number;
}

/**
 * Real measurement, via a 2D canvas context. This is the only text authority in
 * the browser: the DOM renders lines this module already decided on, so there is
 * no second layout engine that could disagree with it.
 */
class CanvasTextMeasurer implements TextMeasurer {
  private readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private readonly widths = new Lru<string, number>(8000);
  private readonly metricsCache = new Map<string, FontMetrics>();
  private readonly charWidths = new Map<string, number>();

  constructor(context?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
    const ctx = context ?? document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('A 2D canvas context is required to measure text.');
    this.context = ctx;
  }

  width(text: string, font: FontSpec): number {
    if (text === '') return 0;
    const key = `${cssFont(font)}\u0000${text}`;
    const cached = this.widths.get(key);
    if (cached !== undefined) return cached;
    this.context.font = cssFont(font);
    return this.widths.set(key, this.context.measureText(text).width);
  }

  metrics(font: FontSpec): FontMetrics {
    const key = cssFont(font);
    const cached = this.metricsCache.get(key);
    if (cached) return cached;
    this.context.font = key;
    const m = this.context.measureText('Hxy');
    // `fontBoundingBox*` is the honest answer and is available in every browser
    // we target; the ratios are a defensive fallback, not a normal path.
    const metrics: FontMetrics = {
      ascent: m.fontBoundingBoxAscent || font.size * 0.8,
      descent: m.fontBoundingBoxDescent || font.size * 0.2,
    };
    this.metricsCache.set(key, metrics);
    return metrics;
  }

  charWidth(font: FontSpec): number {
    const key = cssFont(font);
    const cached = this.charWidths.get(key);
    if (cached !== undefined) return cached;
    this.context.font = key;
    // Monospace: every advance is identical, so one sample is the whole answer.
    const width = this.context.measureText('0').width;
    this.charWidths.set(key, width);
    return width;
  }
}

const NARROW_CHARS = new Set('iljtfIr.,:;\'"`|!()[]{}-'.split(''));
const WIDE_CHARS = new Set('mwMW@%'.split(''));
/** Start of the CJK/ideographic range, where glyphs are full-width. */
const CJK_START = 0x2e80;

/**
 * Deterministic stand-in for environments without a canvas — jsdom unit tests,
 * and any server-side use later. Widths are approximate but stable, which is
 * exactly what a layout test needs.
 */
export class StaticTextMeasurer implements TextMeasurer {
  width(text: string, font: FontSpec): number {
    if (font.stack === 'mono') return text.length * this.charWidth(font);
    let units = 0;
    for (const ch of text) {
      if ((ch.codePointAt(0) ?? 0) >= CJK_START) units += 1;
      else if (NARROW_CHARS.has(ch)) units += 0.34;
      else if (WIDE_CHARS.has(ch)) units += 0.92;
      else if (ch === ' ') units += 0.28;
      else units += 0.55;
    }
    const weightFactor = font.weight >= 600 ? 1.04 : 1;
    return units * font.size * weightFactor;
  }

  metrics(font: FontSpec): FontMetrics {
    return { ascent: font.size * 0.8, descent: font.size * 0.2 };
  }

  charWidth(font: FontSpec): number {
    return font.size * 0.6;
  }
}

/**
 * The same real measurement from a worker, which has no `document` to make a canvas with. `null`
 * where OffscreenCanvas has no 2D context (older WebKit) — the caller then measures on the main
 * thread instead, rather than accept approximate widths that would disagree with the canvas.
 */
export function createOffscreenMeasurer(): TextMeasurer | null {
  try {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const context = new OffscreenCanvas(1, 1).getContext('2d');
    return context ? new CanvasTextMeasurer(context) : null;
  } catch {
    return null;
  }
}

let shared: TextMeasurer | null = null;

/** The measurer the app uses. Falls back automatically when canvas is absent. */
export function getMeasurer(): TextMeasurer {
  if (shared) return shared;
  try {
    shared = new CanvasTextMeasurer();
  } catch {
    shared = new StaticTextMeasurer();
  }
  return shared;
}

/** Test seam. */
export function setMeasurer(measurer: TextMeasurer | null): void {
  shared = measurer;
}
