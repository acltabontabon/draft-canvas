import { LIMITS } from '../../document/limits';
import { Lru } from '../../lib/lru';
import { cssFont, LINE_HEIGHTS, type FontSpec } from './fonts';
import { parseMarkdown, type CalloutKind, type Frame, type Inline, type InlineStyle, type ListMarker, type RichBlock, type TextLevel } from './markdown';
import { getMeasurer, type TextMeasurer } from './measure';

export interface LaidOutLine {
  text: string;
  width: number;
}

export interface TextLayout {
  lines: LaidOutLine[];
  /** Width of the widest line. */
  width: number;
  height: number;
  lineHeight: number;
  ascent: number;
  descent: number;
  truncated: boolean;
  /**
   * `rtl` when the text's first strongly directional character is Hebrew, Arabic or another
   * right-to-left script — its base direction, the way `dir="auto"` decides it. Absent means
   * left-to-right. Without it Arabic and Hebrew labels drew with their punctuation and any Latin
   * words in the wrong places, laid out as if they read left to right.
   */
  direction?: 'rtl';
}

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const STRONG_CHAR = /\p{L}/u;

/** A paragraph's base direction, from its first strong character (Unicode's rule, and `dir="auto"`'s). */
export function baseDirection(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (STRONG_CHAR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

export interface LayoutOptions {
  font: FontSpec;
  maxWidth: number;
  lineHeight: number;
  maxLines?: number;
  measurer?: TextMeasurer;
}

const ELLIPSIS = '…';

/**
 * Break opportunities. `Intl.Segmenter` is used where available because
 * `split(' ')` cannot wrap Chinese, Japanese or Thai at all. The regex path is
 * a fallback for the handful of runtimes that lack it.
 */
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/**
 * User-perceived characters: an emoji with its skin tone, a flag, a letter with its combining accent.
 * Breaking or cutting inside one draws half of it (or a stray accent on the next line). Code points
 * are the fallback where `Intl.Segmenter` is missing — still never half a surrogate pair.
 */
const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemes(text: string): string[] {
  return graphemeSegmenter ? [...graphemeSegmenter.segment(text)].map((s) => s.segment) : [...text];
}

function segments(text: string): string[] {
  const raw = segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : (text.match(/\s+|\S+/g) ?? []);
  return mergeOrphanPunctuation(raw);
}

/** A segment made entirely of punctuation, with nothing else in it to wrap around. */
const PUNCTUATION_ONLY = /^\p{P}+$/u;

/**
 * `Intl.Segmenter`'s word granularity gives trailing punctuation its own segment ("correct?" ->
 * "correct", "?"), so the wrap loop can leave it to open the next line alone once the word ahead of
 * it just barely doesn't fit. Fused onto the segment before it, punctuation always wraps with the
 * word it closes — except when it opens the text, where it's the author's own leading mark (a bullet,
 * an opening quote) and belongs on its own.
 */
function mergeOrphanPunctuation(pieces: string[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    if (out.length > 0 && PUNCTUATION_ONLY.test(piece)) out[out.length - 1] += piece;
    else out.push(piece);
  }
  return out;
}

/** One cache per measurer: a layout is only true for the measurer that measured it, and a key
 *  without it handed one measurer's lines to another (the export's and a test's, say). */
let layoutCaches = new WeakMap<TextMeasurer, Lru<string, TextLayout>>();

/** Sized for one pass over a diagram at the document limits: a shape lays out its name,
 *  description, technology and caption (and `fitLabel` one entry per size it tries), a connector its
 *  label. At 2,000, a pass over a large diagram evicted its own entries before reaching them again,
 *  so leaving a room or exporting after the canvas pass laid every label out from scratch. */
const LAYOUT_CACHE_SIZE = LIMITS.maxNodes * 3 + LIMITS.maxEdges;

function layoutCacheFor(measurer: TextMeasurer): Lru<string, TextLayout> {
  let cache = layoutCaches.get(measurer);
  if (!cache) layoutCaches.set(measurer, (cache = new Lru<string, TextLayout>(LAYOUT_CACHE_SIZE)));
  return cache;
}

/**
 * The single text-layout implementation in the application.
 *
 * Both the on-screen node and the SVG exporter render the lines this function
 * produces — the DOM one element per line with `white-space: pre`, the exporter
 * one `<text>` per line. Because neither side ever wraps on its own, an export
 * cannot disagree with the screen.
 */
export function layoutText(text: string, options: LayoutOptions): TextLayout {
  const measurer = options.measurer ?? getMeasurer();
  const key = `${cssFont(options.font)}|${options.maxWidth}|${options.lineHeight}|${options.maxLines ?? 0}|${text}`;
  const layoutCache = layoutCacheFor(measurer);
  const cached = layoutCache.get(key);
  if (cached) return cached;

  const { font, maxWidth, lineHeight } = options;
  const maxLines = options.maxLines ?? Infinity;
  const { ascent, descent } = measurer.metrics(font);

  const lines: string[] = [];
  let truncated = false;

  const atLimit = () => lines.length >= maxLines;
  // CR and CRLF break lines too: import validation deliberately keeps `\r` (it is legitimate in
  // code), and a stray one at the end of a line would otherwise be measured and drawn as a glyph.
  const paragraphs = text.split(/\r\n|\r|\n/);

  outer: for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    const moreParagraphs = index < paragraphs.length - 1;
    const linesBefore = lines.length;

    if (paragraph === '') {
      lines.push('');
      if (atLimit()) {
        // Only truncated if there was still something left to show.
        truncated = moreParagraphs;
        break;
      }
      continue;
    }

    let current = '';
    for (const piece of segments(paragraph)) {
      // Leading whitespace on a wrapped continuation line is dropped rather than indenting it;
      // at the start of a paragraph it is the author's own indentation (a nested bullet in a
      // note) and is kept.
      const continuation = current === '' && lines.length > linesBefore;
      let pending = continuation ? piece.trimStart() : piece;
      if (pending === '') continue;

      if (measurer.width((current + pending).trimEnd(), font) <= maxWidth) {
        current += pending;
        continue;
      }

      if (current !== '') {
        lines.push(current.trimEnd());
        if (atLimit()) {
          // `pending` still needs a home, so content really was cut.
          truncated = true;
          break outer;
        }
        current = '';
        pending = pending.trimStart();
      }

      // On a line of its own and still too wide: a URL, a hash, an identifier.
      // It is broken by grapheme rather than allowed to overflow the box.
      if (measurer.width(pending.trimEnd(), font) > maxWidth) {
        const broken = breakLongToken(pending, font, maxWidth, measurer);
        for (let i = 0; i < broken.length - 1; i += 1) {
          lines.push(broken[i]!);
          if (atLimit()) {
            truncated = true;
            break outer;
          }
        }
        current = broken[broken.length - 1] ?? '';
      } else {
        current = pending;
      }
    }

    if (current !== '' || lines.length === linesBefore) lines.push(current.trimEnd());
    if (atLimit()) {
      truncated = moreParagraphs;
      break;
    }
  }

  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = ellipsize(lines[lines.length - 1]!, font, maxWidth, measurer);
  }

  // Measure each final line once, so widths are exact rather than the sum of
  // per-word measurements (kerning across a join would otherwise drift).
  const laidOut: LaidOutLine[] = lines.map((line) => ({
    text: line,
    width: measurer.width(line, font),
  }));

  const layout: TextLayout = {
    lines: laidOut,
    width: laidOut.reduce((max, line) => Math.max(max, line.width), 0),
    height: laidOut.length * lineHeight,
    lineHeight,
    ascent,
    descent,
    truncated,
    ...(baseDirection(text) === 'rtl' ? { direction: 'rtl' as const } : {}),
  };
  return layoutCache.set(key, layout);
}

export interface FitLabelOptions {
  /** The preferred size and the family/weight to shrink within — every step of the ladder keeps
   *  the same stack/weight/italic, only `size` changes. */
  font: FontSpec;
  /** Floor of the shrink ladder. Never shrinks below this even if the text still doesn't fit —
   *  `layoutText`'s own ellipsis takes over at that point. */
  minFontSize: number;
  maxWidth: number;
  /** Vertical room available for the label. How many lines fit at a given size is derived from
   *  this, not passed in — a smaller font naturally earns room for one more line. */
  maxHeight: number;
  /** `LINE_HEIGHTS.label`/`.body`/etc. — line height is `size * lineHeightRatio` at every step of
   *  the ladder, so it shrinks in lockstep with the font. */
  lineHeightRatio: number;
  /** A hard line-count ceiling independent of `maxHeight` — e.g. 1, for a caption that must stay
   *  single-line even in a tall box. */
  maxLines?: number;
  measurer?: TextMeasurer;
}

export interface FitLabelResult {
  layout: TextLayout;
  /** The font actually used — `options.font` unless shrinking was needed. */
  font: FontSpec;
  lineHeight: number;
}

/**
 * Wrap → shrink → ellipsize, in that order — the graceful-degradation hierarchy every node label
 * goes through instead of jumping straight to truncation. Tries the preferred size first (where
 * `layoutText` already wraps to however many lines `maxHeight` allows); only steps the font size
 * down, one integer pixel at a time, when that still doesn't fit. Draft Canvas's label sizes are
 * small (a handful of px between preferred and minimum), so this bounded ladder is cheap and every
 * step is a `layoutText` call, which is itself cached — there is no per-frame measurement loop.
 */
export function fitLabel(text: string, options: FitLabelOptions): FitLabelResult {
  const measurer = options.measurer ?? getMeasurer();
  const preferred = options.font.size;
  const min = Math.min(options.minFontSize, preferred);

  let attempt: FitLabelResult | null = null;
  for (let size = preferred; size >= min; size -= 1) {
    const font: FontSpec = { ...options.font, size };
    const lineHeight = size * options.lineHeightRatio;
    const linesFromHeight = Math.max(1, Math.floor(options.maxHeight / lineHeight));
    const maxLines = options.maxLines === undefined ? linesFromHeight : Math.min(options.maxLines, linesFromHeight);
    const layout = layoutText(text, { font, maxWidth: options.maxWidth, lineHeight, maxLines, measurer });
    attempt = { layout, font, lineHeight };
    if (!layout.truncated) return attempt;
  }
  // Nothing fit, not even at `minFontSize` — `attempt` is that minimum-size try, whose own last
  // line `layoutText` already ellipsized. The loop always runs at least once (`min <= preferred`),
  // so `attempt` is never null here.
  return attempt!;
}

function breakLongToken(
  token: string,
  font: FontSpec,
  maxWidth: number,
  measurer: TextMeasurer,
): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of graphemes(token)) {
    const candidate = current + ch;
    if (current !== '' && measurer.width(candidate, font) > maxWidth) {
      out.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  out.push(current);
  return out;
}

function ellipsize(
  line: string,
  font: FontSpec,
  maxWidth: number,
  measurer: TextMeasurer,
): string {
  if (measurer.width(line + ELLIPSIS, font) <= maxWidth) return line + ELLIPSIS;
  // A whole grapheme at a time: half an emoji renders as a replacement box, and a letter without its
  // accent is a different letter.
  const parts = graphemes(line);
  while (parts.length > 0 && measurer.width(parts.join('') + ELLIPSIS, font) > maxWidth) parts.pop();
  return parts.join('') + ELLIPSIS;
}

/**
 * Baseline of line `index` relative to the top of the text block.
 *
 * SVG anchors text at the baseline while the DOM anchors line boxes at the top,
 * and `dominant-baseline` is inconsistent between renderers. Computing this
 * explicitly, in one place, is what keeps exported text from sitting a couple of
 * pixels off.
 */
export function baselineOf(layout: TextLayout, index: number): number {
  // A line box distributes its spare space evenly above and below the glyph
  // box, so the baseline sits half a leading plus the ascent below the top.
  const halfLeading = (layout.lineHeight - (layout.ascent + layout.descent)) / 2;
  return index * layout.lineHeight + halfLeading + layout.ascent;
}

/** Test seam: `tests/setup.ts` empties it between tests. */
export function clearLayoutCache(): void {
  layoutCaches = new WeakMap();
  richCaches = new WeakMap();
}

/* ------------------------------------------------------------------------------------------------
 * Rich text: Markdown laid out into lines of styled runs.
 *
 * Still the one wrapping implementation — the same break opportunities (`segments`), the same
 * grapheme rules, the same measurer — applied to runs that each carry their own font. A Text
 * element's canvas drawing and its export both draw exactly the lines and boxes produced here.
 * ---------------------------------------------------------------------------------------------- */

export interface RichTextOptions {
  /** The body font. Headings, inline code and code blocks are sized from it. */
  font: FontSpec;
  maxWidth: number;
  /** `LINE_HEIGHTS.body` and friends: every line's height is its largest font's size times this. */
  lineHeightRatio: number;
  /** Content past this is cut, and the last line that still fits ends in an ellipsis. */
  maxHeight?: number;
  measurer?: TextMeasurer;
}

export interface RichRun {
  text: string;
  /** From the line's own left edge, before alignment. Includes `pad`. */
  x: number;
  width: number;
  font: FontSpec;
  style: InlineStyle;
  /** Room either side of the glyphs — an inline code chip's padding. */
  pad: number;
}

export type RichMarker =
  | { kind: 'bullet'; depth: number; x: number; size: number }
  | { kind: 'number'; text: string; x: number; width: number; font: FontSpec }
  | { kind: 'task'; checked: boolean; x: number; size: number }
  | { kind: 'callout'; callout: CalloutKind; x: number; size: number };

export interface RichLine {
  top: number;
  height: number;
  /** From `top`. */
  baseline: number;
  /** Where the line's text begins, before alignment. */
  left: number;
  /** The width this line may use from `left`. */
  avail: number;
  /** The runs' extent. */
  width: number;
  runs: RichRun[];
  /** Absolute x, never moved by alignment: a gutter belongs to the block, not the line. */
  marker?: RichMarker;
  /** Fixed alignment (a table cell's). Absent: the element's own alignment applies. */
  align?: 'start' | 'middle' | 'end';
  level: TextLevel | 'cell';
  callout?: CalloutKind;
  /** Inside a quote: set quieter than the words around it. */
  muted?: boolean;
  rtl?: boolean;
}

export type RichBox =
  | {
      kind: 'code';
      x: number;
      y: number;
      w: number;
      h: number;
      code: string;
      lang: string;
      font: FontSpec;
      lineHeight: number;
      header: number;
      padX: number;
      padY: number;
      /** Lines that fit; the rest were cut by `maxHeight`. */
      visibleLines: number;
    }
  | { kind: 'rule'; x: number; y: number; w: number }
  | { kind: 'frame'; frame: Frame; x: number; y: number; w: number; h: number }
  | {
      kind: 'table';
      x: number;
      y: number;
      w: number;
      h: number;
      columns: { x: number; w: number }[];
      rows: { y: number; h: number; header: boolean }[];
    };

export interface RichTextLayout {
  lines: RichLine[];
  /** Drawn behind the lines, in this order. */
  boxes: RichBox[];
  /** The extent actually used at `maxWidth`. */
  width: number;
  height: number;
  /** What the content would like: code and tables at their unwrapped widths. */
  naturalWidth: number;
  truncated: boolean;
}

const HEADING_SCALE: Record<TextLevel, number> = { body: 1, h1: 1.6, h2: 1.3, h3: 1.12 };
const CODE_SCALE = 0.88;
const CODE_BLOCK_SCALE = 0.86;
export const INLINE_CODE_PAD = 3;
const QUOTE_INSET = 14;
const CALLOUT_INSET = 16;
const CALLOUT_PAD_RIGHT = 10;
const CALLOUT_PAD_Y = 8;
const QUOTE_PAD_Y = 2;
const TABLE_CELL_PAD = 8;
const TABLE_ROW_PAD = 4;
const CODE_PAD_X = 10;
const CODE_PAD_Y = 8;
const CODE_HEADER = 18;

const half = (value: number) => Math.round(value * 2) / 2;

export function richFontFor(base: FontSpec, level: TextLevel | 'cell', style: InlineStyle): FontSpec {
  if (style.code) {
    const weight = style.bold ? 700 : base.weight >= 600 ? 600 : base.weight >= 500 ? 500 : 400;
    return { stack: 'mono', size: half(base.size * CODE_SCALE), weight, ...(style.italic || base.italic ? { italic: true } : {}) };
  }
  const scale = level === 'cell' ? 1 : HEADING_SCALE[level];
  const levelWeight = level === 'h1' || level === 'h2' ? 700 : level === 'h3' ? 600 : base.weight;
  const weight = style.bold ? 700 : (Math.max(base.weight, levelWeight) as FontSpec['weight']);
  return {
    stack: base.stack,
    size: scale === 1 ? base.size : half(base.size * scale),
    weight,
    ...(style.italic || base.italic ? { italic: true } : {}),
  };
}

export function codeBlockFont(base: FontSpec): FontSpec {
  return { stack: 'mono', size: Math.max(9, half(base.size * CODE_BLOCK_SCALE)), weight: 400 };
}

interface Piece {
  text: string;
  style: InlineStyle;
  font: FontSpec;
  width: number;
}

interface Unit {
  pieces: Piece[];
  width: number;
  space: boolean;
  hard?: boolean;
}

const styleKey = (style: InlineStyle) =>
  `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}${style.strike ? 's' : ''}${style.code ? 'c' : ''}${style.mark ? 'm' : ''}${style.link ? 'l' : ''}${style.color ?? ''}`;

/** Inline runs → unbreakable units, glued wherever two runs meet without whitespace between them. */
function unitsOf(runs: Inline[], level: TextLevel | 'cell', base: FontSpec, measurer: TextMeasurer): Unit[] {
  const units: Unit[] = [];
  for (const run of runs) {
    if ('break' in run) {
      units.push({ pieces: [], width: 0, space: false, hard: true });
      continue;
    }
    if (run.text === '') continue;
    const font = richFontFor(base, level, run.style);
    // Inline code is one chip: it wraps as a whole, and only breaks inside when it can't fit alone.
    const parts = run.style.code ? [run.text] : segments(run.text);
    parts.forEach((part, index) => {
      const space = /^\s+$/u.test(part);
      const width = measurer.width(part, font) + (run.style.code ? INLINE_CODE_PAD * 2 : 0);
      const piece: Piece = { text: part, style: run.style, font, width };
      const last = units[units.length - 1];
      if (index === 0 && !space && last && !last.space && !last.hard) {
        last.pieces.push(piece);
        last.width += width;
      } else {
        units.push({ pieces: [piece], width, space });
      }
    });
  }
  return units;
}

/** A unit wider than a whole line, cut between graphemes — a URL, a long identifier. */
function breakUnit(unit: Unit, avail: number, measurer: TextMeasurer): Piece[][] {
  const out: Piece[][] = [];
  let current: Piece[] = [];
  let width = 0;
  for (const piece of unit.pieces) {
    const extra = piece.style.code ? INLINE_CODE_PAD * 2 : 0;
    for (const grapheme of graphemes(piece.text)) {
      const w = measurer.width(grapheme, piece.font);
      if (width + w + extra > avail && current.length > 0) {
        out.push(current);
        current = [];
        width = 0;
      }
      const last = current[current.length - 1];
      if (last && last.style === piece.style && last.font === piece.font) last.text += grapheme;
      else current.push({ ...piece, text: grapheme, width: 0 });
      width += w;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function wrapUnits(units: Unit[], avail: number, measurer: TextMeasurer): Piece[][] {
  const lines: Piece[][] = [];
  let current: Piece[] = [];
  let width = 0;
  const trimEnd = (pieces: Piece[]) => {
    while (pieces.length > 0 && /^\s*$/u.test(pieces[pieces.length - 1]!.text)) pieces.pop();
    return pieces;
  };
  const flush = () => {
    lines.push(trimEnd(current));
    current = [];
    width = 0;
  };
  for (const unit of units) {
    if (unit.hard) {
      flush();
      continue;
    }
    if (unit.space) {
      if (current.length === 0) continue;
      current.push(...unit.pieces);
      width += unit.width;
      continue;
    }
    if (current.length > 0 && width + unit.width > avail) flush();
    if (current.length === 0 && unit.width > avail) {
      const broken = breakUnit(unit, avail, measurer);
      for (let i = 0; i < broken.length - 1; i += 1) lines.push(broken[i]!);
      current = broken[broken.length - 1] ?? [];
      width = current.reduce((sum, piece) => sum + measurer.width(piece.text, piece.font), 0);
      continue;
    }
    current.push(...unit.pieces);
    width += unit.width;
  }
  if (current.length > 0 || lines.length === 0) flush();
  return lines;
}

/** Adjacent pieces of one style become one run, measured once — kerning across a join stays exact. */
function runsOf(pieces: Piece[], measurer: TextMeasurer): { runs: RichRun[]; width: number } {
  const runs: RichRun[] = [];
  let x = 0;
  let open: { text: string; style: InlineStyle; font: FontSpec } | null = null;
  const close = () => {
    if (!open) return;
    const pad = open.style.code ? INLINE_CODE_PAD : 0;
    const width = measurer.width(open.text, open.font) + pad * 2;
    runs.push({ text: open.text, x, width, font: open.font, style: open.style, pad });
    x += width;
    open = null;
  };
  for (const piece of pieces) {
    if (open && styleKey(open.style) === styleKey(piece.style) && cssFont(open.font) === cssFont(piece.font)) {
      open.text += piece.text;
    } else {
      close();
      open = { text: piece.text, style: piece.style, font: piece.font };
    }
  }
  close();
  return { runs, width: x };
}

function lineMetrics(
  runs: RichRun[],
  fallback: FontSpec,
  ratio: number,
  measurer: TextMeasurer,
): { height: number; baseline: number } {
  const fonts = runs.length > 0 ? runs.map((run) => run.font) : [fallback];
  // The line box follows its largest text; inline code is set smaller and never sets the height.
  const tallest = fonts.reduce((max, font) => Math.max(max, font.size), fallback.size);
  const height = tallest * ratio;
  let ascent = 0;
  let descent = 0;
  for (const font of fonts) {
    const m = measurer.metrics(font);
    ascent = Math.max(ascent, m.ascent);
    descent = Math.max(descent, m.descent);
  }
  return { height, baseline: (height - (ascent + descent)) / 2 + ascent };
}

function ellipsizeLine(line: RichLine, measurer: TextMeasurer): void {
  const last = line.runs[line.runs.length - 1];
  if (!last) return;
  const room = line.avail - (line.width - last.width) - last.pad * 2;
  const parts = graphemes(last.text);
  while (parts.length > 0 && measurer.width(parts.join('').trimEnd() + ELLIPSIS, last.font) > room) parts.pop();
  last.text = parts.join('').trimEnd() + ELLIPSIS;
  last.width = measurer.width(last.text, last.font) + last.pad * 2;
  line.width = last.x + last.width;
}

function plainOf(runs: Inline[]): string {
  return runs.map((run) => ('break' in run ? '\n' : run.text)).join('');
}

let richCaches = new WeakMap<TextMeasurer, Lru<string, RichTextLayout>>();

function richCacheFor(measurer: TextMeasurer): Lru<string, RichTextLayout> {
  let cache = richCaches.get(measurer);
  if (!cache) richCaches.set(measurer, (cache = new Lru<string, RichTextLayout>(LIMITS.maxNodes * 2)));
  return cache;
}

/**
 * Lays Markdown out for a box `maxWidth` wide: wrapped lines of styled runs, plus the boxes drawn
 * behind them (code blocks, tables, quotes and callouts, rules). Cached per measurer, like
 * `layoutText`.
 */
export function layoutRichText(source: string, options: RichTextOptions): RichTextLayout {
  const measurer = options.measurer ?? getMeasurer();
  const key = `${cssFont(options.font)}|${options.maxWidth}|${options.lineHeightRatio}|${options.maxHeight ?? ''}|${source}`;
  const cache = richCacheFor(measurer);
  const cached = cache.get(key);
  if (cached) return cached;
  return cache.set(key, computeRichLayout(parseMarkdown(source), options, measurer));
}

function computeRichLayout(blocks: RichBlock[], options: RichTextOptions, measurer: TextMeasurer): RichTextLayout {
  const { font: base, maxWidth, lineHeightRatio: ratio } = options;
  const maxHeight = options.maxHeight ?? Infinity;
  const gutter = Math.round(base.size * 1.5);
  const paragraphGap = base.size * 0.55;
  const headingGap = base.size * 0.8;

  const lines: RichLine[] = [];
  const boxes: RichBox[] = [];
  let y = 0;
  let naturalWidth = 0;
  let truncated = false;
  const open: { frame: Frame; x: number; y: number; box: Extract<RichBox, { kind: 'frame' }> }[] = [];

  const insetOf = (frame: Frame) => (frame.kind === 'callout' ? CALLOUT_INSET : QUOTE_INSET);
  const rightPadOf = (frame: Frame) => (frame.kind === 'callout' ? CALLOUT_PAD_RIGHT : 0);
  const padYOf = (frame: Frame) => (frame.kind === 'callout' ? CALLOUT_PAD_Y : QUOTE_PAD_Y);
  const fits = (bottom: number) => bottom <= maxHeight + 0.5;

  const closeFramesTo = (depth: number) => {
    while (open.length > depth) {
      const entry = open.pop()!;
      y = Math.min(y + padYOf(entry.frame), Math.max(y, maxHeight));
      entry.box.h = y - entry.box.y;
    }
  };


  blocks: for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;

    // Frames: close what this block is outside of, then open what it newly sits in.
    let shared = 0;
    while (shared < open.length && shared < block.frames.length && open[shared]!.frame === block.frames[shared]) shared += 1;
    closeFramesTo(shared);

    const level = block.kind === 'text' ? block.level : 'body';
    const gap =
      index === 0 || block.tight ? 0 : level === 'h1' || level === 'h2' || level === 'h3' ? headingGap : paragraphGap;
    // A frame's own top padding replaces the gap above its first block.
    if (shared < block.frames.length) {
      y += open.length === 0 && index > 0 ? paragraphGap : 0;
    } else {
      y += gap;
    }
    let frameLeft = 0;
    let frameRight = maxWidth;
    for (let depth = 0; depth < block.frames.length; depth += 1) {
      const frame = block.frames[depth]!;
      if (depth >= open.length) {
        const box: Extract<RichBox, { kind: 'frame' }> = { kind: 'frame', frame, x: frameLeft, y, w: frameRight - frameLeft, h: 0 };
        boxes.push(box);
        open.push({ frame, x: frameLeft, y, box });
        y += padYOf(frame);
      }
      frameLeft += insetOf(frame);
      frameRight -= rightPadOf(frame);
    }

    const left = frameLeft + block.indent * gutter;

    if (block.kind === 'text') {
      const marked = block.marker !== undefined || block.callout !== undefined;
      const textLeft = marked ? left + (block.callout ? Math.round(base.size * 1.25) : gutter) : left;
      const textAvail = Math.max(16, frameRight - textLeft);
      const font = richFontFor(base, block.level, {});
      const pieces = wrapUnits(unitsOf(block.runs, block.level, base, measurer), textAvail, measurer);
      const rtl = baseDirection(plainOf(block.runs)) === 'rtl';
      for (let i = 0; i < pieces.length; i += 1) {
        const { runs, width } = runsOf(pieces[i]!, measurer);
        const { height, baseline } = lineMetrics(runs, font, ratio, measurer);
        if (!fits(y + height)) {
          truncated = true;
          const previous = lines[lines.length - 1];
          if (previous) ellipsizeLine(previous, measurer);
          break blocks;
        }
        if (rtl) for (const run of runs) run.x = width - run.x - run.width;
        const line: RichLine = { top: y, height, baseline, left: textLeft, avail: textAvail, width, runs, level: block.level };
        if (rtl) line.rtl = true;
        if (block.frames.some((frame) => frame.kind === 'quote')) line.muted = true;
        if (i === 0 && block.marker) line.marker = markerOf(block.marker, left, gutter, font, measurer);
        if (i === 0 && block.callout) {
          line.callout = block.callout;
          const size = Math.round(font.size * 0.9);
          line.marker = { kind: 'callout', callout: block.callout, x: left, size };
        }
        lines.push(line);
        naturalWidth = Math.max(naturalWidth, textLeft + width + (maxWidth - frameRight));
        y += height;
      }
      continue;
    }

    if (block.kind === 'rule') {
      const height = base.size * 0.9;
      if (!fits(y + height)) {
        truncated = true;
        break;
      }
      boxes.push({ kind: 'rule', x: left, y: y + height / 2, w: frameRight - left });
      y += height;
      continue;
    }

    if (block.kind === 'code') {
      const font = codeBlockFont(base);
      const lineHeight = font.size * LINE_HEIGHTS.code;
      const header = block.lang ? CODE_HEADER : 0;
      const codeLines = block.code.split('\n');
      const chrome = header + CODE_PAD_Y * 2;
      const room = Math.floor((Math.min(maxHeight, 1e9) - y - chrome) / lineHeight);
      const visibleLines = Math.min(codeLines.length, room);
      if (visibleLines < 1) {
        truncated = true;
        break;
      }
      if (visibleLines < codeLines.length) truncated = true;
      const h = chrome + Math.max(1, visibleLines) * lineHeight;
      const longest = codeLines.reduce((max, line) => Math.max(max, line.replace(/\t/g, '  ').length), 0);
      naturalWidth = Math.max(naturalWidth, left + longest * measurer.charWidth(font) + CODE_PAD_X * 2 + (maxWidth - frameRight));
      boxes.push({ kind: 'code', x: left, y, w: frameRight - left, h, code: block.code, lang: block.lang, font, lineHeight, header, padX: CODE_PAD_X, padY: CODE_PAD_Y, visibleLines });
      y += h;
      if (truncated) break;
      continue;
    }

    // Table: one line per cell, columns at their natural widths and shared out when they don't fit.
    const all = [block.head, ...block.rows];
    const columns = Math.max(...all.map((row) => row.length));
    const natural = Array.from({ length: columns }, (_, column) =>
      Math.max(
        24,
        ...all.map((row) => runsOf(unitsOf(row[column] ?? [], 'cell', base, measurer).flatMap((unit) => unit.pieces), measurer).width + TABLE_CELL_PAD * 2),
      ),
    );
    const naturalTotal = natural.reduce((sum, w) => sum + w, 0);
    naturalWidth = Math.max(naturalWidth, left + naturalTotal + (maxWidth - frameRight));
    const tableWidth = frameRight - left;
    const widths = naturalTotal <= tableWidth ? natural : natural.map((w) => Math.max(24, (w / naturalTotal) * tableWidth));
    const columnBoxes: { x: number; w: number }[] = [];
    let cx = left;
    for (const w of widths) {
      columnBoxes.push({ x: cx, w });
      cx += w;
    }
    const cellFont = richFontFor(base, 'cell', {});
    const rowHeight = cellFont.size * ratio + TABLE_ROW_PAD * 2;
    const table: Extract<RichBox, { kind: 'table' }> = { kind: 'table', x: left, y, w: cx - left, h: 0, columns: columnBoxes, rows: [] };
    boxes.push(table);
    for (let r = 0; r < all.length; r += 1) {
      if (!fits(y + rowHeight)) {
        truncated = true;
        break;
      }
      table.rows.push({ y, h: rowHeight, header: r === 0 });
      for (let column = 0; column < columns; column += 1) {
        const cell = all[r]![column] ?? [];
        const box = columnBoxes[column]!;
        const cellAvail = Math.max(8, box.w - TABLE_CELL_PAD * 2);
        const pieces = unitsOf(cell, 'cell', base, measurer).flatMap((unit) => (unit.hard ? [{ text: ' ', style: {}, font: cellFont, width: 0 }] : unit.pieces));
        const { runs, width } = runsOf(pieces, measurer);
        const { height, baseline } = lineMetrics(runs, cellFont, ratio, measurer);
        const align = block.align[column];
        const line: RichLine = {
          top: y + TABLE_ROW_PAD,
          height,
          baseline,
          left: box.x + TABLE_CELL_PAD,
          avail: cellAvail,
          width,
          runs,
          level: 'cell',
          align: align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start',
        };
        if (width > cellAvail) ellipsizeLine(line, measurer);
        lines.push(line);
      }
      y += rowHeight;
    }
    table.h = y - table.y;
    if (truncated) break;
  }

  closeFramesTo(0);

  return { lines, boxes, width: Math.min(maxWidth, naturalWidth), height: y, naturalWidth, truncated };
}

function markerOf(
  marker: ListMarker,
  left: number,
  gutter: number,
  font: FontSpec,
  measurer: TextMeasurer,
): RichMarker {
  if (marker.kind === 'bullet') return { kind: 'bullet', depth: marker.depth, x: left + gutter * 0.35, size: Math.max(3, font.size * 0.32) };
  if (marker.kind === 'task') return { kind: 'task', checked: marker.checked, x: left, size: Math.round(font.size * 0.95) };
  const text = `${marker.value}.`;
  const numberFont: FontSpec = { ...font, weight: font.weight >= 600 ? font.weight : 500 };
  const width = measurer.width(text, numberFont);
  // Right-aligned against the text, so 9. and 10. line their full stops up.
  return { kind: 'number', text, x: left + gutter - width - font.size * 0.3, width, font: numberFont };
}

/** Test seam, alongside `clearLayoutCache`. */
export function clearRichLayoutCache(): void {
  richCaches.delete(getMeasurer());
}
