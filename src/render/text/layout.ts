import { Lru } from '../../lib/lru';
import { cssFont, type FontSpec } from './fonts';
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

function segments(text: string): string[] {
  if (!segmenter) return text.match(/\s+|\S+/g) ?? [];
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

const layoutCache = new Lru<string, TextLayout>(2000);

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
  for (const ch of token) {
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
  let cut = line;
  while (cut.length > 0 && measurer.width(cut + ELLIPSIS, font) > maxWidth) {
    // A whole code point at a time: half an emoji renders as a replacement box.
    cut = cut.slice(0, /[\uDC00-\uDFFF]$/.test(cut) && cut.length > 1 ? -2 : -1);
  }
  return cut + ELLIPSIS;
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
  layoutCache.clear();
}
