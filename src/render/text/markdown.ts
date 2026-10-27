import { Marked, type Token, type Tokens, type TokenizerExtension } from 'marked';
import { ACCENTS, type Accent } from '../../document/types';
import { LIMITS } from '../../document/limits';
import { Lru } from '../../lib/lru';

/**
 * A Text element's words are Markdown: what a developer already writes in a README, a pull request
 * or a commit message, and what an agent writes without being taught. This module turns that source
 * into a small block model — paragraphs, headings, list items, code, tables, callouts — and nothing
 * else. It never measures or wraps (that is `layout.ts`'s alone) and never draws (`nodes/describe.ts`).
 *
 * `marked` does the parsing, with GitHub's dialect (tables, task lists, ~~strikethrough~~, autolinks)
 * and three deliberate changes for a canvas:
 *
 * - A single newline is a line break, the way every other text box in the app behaves.
 * - Indented code is off. Indenting a line in a canvas label is formatting, not a request for a
 *   code block; fenced code (```) is how code is written here.
 * - Raw HTML is shown as typed. Nothing in a diagram is ever interpreted as markup.
 *
 * Plus two inline additions: `==highlighted==` (Obsidian's and many editors' marker) and a coloured
 * span, `[words]{.teal}` (Pandoc's bracketed-span syntax), in the diagram's own accent palette.
 */

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  mark?: boolean;
  link?: boolean;
  color?: Accent;
}

export type Inline = { text: string; style: InlineStyle } | { break: true };

export type ListMarker =
  | { kind: 'bullet'; depth: number }
  | { kind: 'number'; value: number }
  | { kind: 'task'; checked: boolean };

/** A container a block sits inside. The same object is shared by every block it holds, which is how
 *  layout knows where one quote or callout ends and the next begins. */
export interface Frame {
  kind: 'quote' | 'callout';
  callout?: CalloutKind;
}

interface BlockBase {
  /** List nesting: how many gutters this block is indented by. */
  indent: number;
  frames: Frame[];
  /** Sits directly under the block before it with no paragraph gap — the next item of a tight list. */
  tight?: boolean;
}

export type TextLevel = 'body' | 'h1' | 'h2' | 'h3';

export type RichBlock =
  | (BlockBase & { kind: 'text'; level: TextLevel; runs: Inline[]; marker?: ListMarker; callout?: CalloutKind })
  | (BlockBase & { kind: 'code'; code: string; lang: string })
  | (BlockBase & { kind: 'rule' })
  | (BlockBase & {
      kind: 'table';
      head: Inline[][];
      rows: Inline[][][];
      align: ('left' | 'center' | 'right' | null)[];
    });

const COLOR_NAMES = new Set<string>(ACCENTS);

const highlight: TokenizerExtension = {
  name: 'mark',
  level: 'inline',
  start: (src) => src.indexOf('=='),
  tokenizer(src) {
    const match = /^==(?=[^\s=])([\s\S]*?[^\s\\])==(?!=)/.exec(src);
    if (!match) return undefined;
    return { type: 'mark', raw: match[0], text: match[1]!, tokens: this.lexer.inlineTokens(match[1]!) };
  },
};

const colorSpan: TokenizerExtension = {
  name: 'colorSpan',
  level: 'inline',
  start: (src) => src.indexOf('['),
  tokenizer(src) {
    const match = /^\[((?:\\.|[^[\]\\])+)\]\{\.([a-z]+)\}/.exec(src);
    if (!match || !COLOR_NAMES.has(match[2]!)) return undefined;
    return { type: 'colorSpan', raw: match[0], color: match[2], text: match[1]!, tokens: this.lexer.inlineTokens(match[1]!) };
  },
};

const parser = new Marked({ gfm: true, breaks: true, async: false });
parser.use({
  extensions: [highlight, colorSpan],
  tokenizer: {
    // `undefined` means "no match here", so the lines fall through to a paragraph.
    code: () => undefined,
  },
});

const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** `marked` leaves entities as typed in text tokens (its renderer is what would decode them). */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower in NAMED) return NAMED[lower]!;
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function inlineOf(tokens: Token[] | undefined, style: InlineStyle, out: Inline[]): Inline[] {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        inlineOf(token.tokens, { ...style, bold: true }, out);
        break;
      case 'em':
        inlineOf(token.tokens, { ...style, italic: true }, out);
        break;
      case 'del':
        inlineOf(token.tokens, { ...style, strike: true }, out);
        break;
      case 'mark':
        inlineOf(token.tokens, { ...style, mark: true }, out);
        break;
      case 'colorSpan':
        inlineOf(token.tokens, { ...style, color: (token as unknown as { color: Accent }).color }, out);
        break;
      case 'link':
        inlineOf(token.tokens, { ...style, link: true }, out);
        break;
      case 'codespan':
        out.push({ text: decodeEntities(token.text), style: { ...style, code: true } });
        break;
      case 'br':
        out.push({ break: true });
        break;
      case 'image':
        out.push({ text: (token as Tokens.Image).text || 'image', style: { ...style, italic: true } });
        break;
      case 'checkbox':
        break;
      case 'text':
        if ('tokens' in token && token.tokens?.length) inlineOf(token.tokens, style, out);
        else out.push({ text: decodeEntities(token.text), style });
        break;
      default:
        // `escape`, inline `html` and anything unknown: its literal text, never markup.
        if ('text' in token && typeof token.text === 'string') out.push({ text: decodeEntities(token.text), style });
        else if (typeof token.raw === 'string') out.push({ text: token.raw, style });
    }
  }
  return out;
}

const CALLOUT_TAG = /^\[!(note|tip|important|warning|caution)\]\s*$/i;

/** GitHub's alert syntax: a quote whose first line is `[!WARNING]` and nothing else. */
function calloutOf(quote: Tokens.Blockquote): CalloutKind | null {
  const first = quote.tokens[0];
  if (first?.type !== 'paragraph') return null;
  const lead = (first as Tokens.Paragraph).tokens[0];
  if (lead?.type !== 'text') return null;
  const match = CALLOUT_TAG.exec(lead.raw);
  return match ? (match[1]!.toLowerCase() as CalloutKind) : null;
}

/** The quote's own tokens minus its `[!KIND]` line (and the break after it). */
function withoutCalloutTag(quote: Tokens.Blockquote): Token[] {
  const [first, ...rest] = quote.tokens;
  const paragraph = first as Tokens.Paragraph;
  let inline = paragraph.tokens.slice(1);
  if (inline[0]?.type === 'br') inline = inline.slice(1);
  return inline.length > 0 ? [{ ...paragraph, tokens: inline }, ...rest] : rest;
}

const CALLOUT_TITLES: Record<CalloutKind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

function blocksOf(tokens: Token[], indent: number, frames: Frame[], out: RichBlock[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph':
      case 'text':
        out.push({ kind: 'text', level: 'body', runs: inlineOf((token as Tokens.Paragraph).tokens, {}, []), indent, frames });
        break;
      case 'heading': {
        const depth = (token as Tokens.Heading).depth;
        const level: TextLevel = depth <= 1 ? 'h1' : depth === 2 ? 'h2' : 'h3';
        out.push({ kind: 'text', level, runs: inlineOf((token as Tokens.Heading).tokens, {}, []), indent, frames });
        break;
      }
      case 'code':
        out.push({ kind: 'code', code: (token as Tokens.Code).text, lang: ((token as Tokens.Code).lang ?? '').trim().split(/\s+/)[0] ?? '', indent, frames });
        break;
      case 'hr':
        out.push({ kind: 'rule', indent, frames });
        break;
      case 'blockquote': {
        const quote = token as Tokens.Blockquote;
        const callout = calloutOf(quote);
        if (callout) {
          const frame: Frame = { kind: 'callout', callout };
          const inner = [...frames, frame];
          out.push({ kind: 'text', level: 'body', runs: [{ text: CALLOUT_TITLES[callout], style: { bold: true } }], indent, frames: inner, callout });
          const start = out.length;
          blocksOf(withoutCalloutTag(quote), indent, inner, out);
          if (out[start]) out[start]!.tight = true;
        } else {
          blocksOf(quote.tokens, indent, [...frames, { kind: 'quote' }], out);
        }
        break;
      }
      case 'list': {
        const list = token as Tokens.List;
        const first = typeof list.start === 'number' ? list.start : 1;
        list.items.forEach((item, index) => {
          const marker: ListMarker = item.task
            ? { kind: 'task', checked: Boolean(item.checked) }
            : list.ordered
              ? { kind: 'number', value: first + index }
              : { kind: 'bullet', depth: indent };
          const children = item.tokens.filter((child) => child.type !== 'checkbox' && child.type !== 'space');
          const lead = children[0];
          const start = out.length;
          if (lead && (lead.type === 'text' || lead.type === 'paragraph')) {
            out.push({ kind: 'text', level: 'body', runs: inlineOf((lead as Tokens.Text).tokens ?? [lead], {}, []), marker, indent, frames });
            blocksOf(children.slice(1), indent + 1, frames, out);
          } else {
            // An item that opens with something other than words (a code block, a nested list):
            // the marker still needs a line of its own to sit on.
            out.push({ kind: 'text', level: 'body', runs: [], marker, indent, frames });
            blocksOf(children, indent + 1, frames, out);
          }
          if (index > 0 && !list.loose && out[start]) out[start]!.tight = true;
          // A tight item's own nested list hugs it too.
          if (!item.loose) for (let i = start + 1; i < out.length; i += 1) out[i]!.tight = true;
        });
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        out.push({
          kind: 'table',
          head: table.header.map((cell) => inlineOf(cell.tokens, { bold: true }, [])),
          rows: table.rows.map((row) => row.map((cell) => inlineOf(cell.tokens, {}, []))),
          align: table.align,
          indent,
          frames,
        });
        break;
      }
      case 'html':
        out.push({ kind: 'text', level: 'body', runs: [{ text: token.raw.replace(/\n+$/, ''), style: {} }], indent, frames });
        break;
      default:
        // `space` and link reference definitions draw nothing.
        break;
    }
  }
}

/** One entry per distinct source a pass over a large diagram meets — the same sizing as layout's. */
const cache = new Lru<string, RichBlock[]>(LIMITS.maxNodes);

/**
 * Inline markers past which a source is shown as written rather than parsed. The parser's emphasis
 * and link matching costs time that grows with the square of how many there are (20,000 characters
 * of `_*a` took three seconds), and a shared diagram's text is written by whoever is in the session.
 * Real writing uses a handful.
 */
const MAX_INLINE_MARKERS = 1000;
const INLINE_MARKER = /[*_~[\]`<]/g;

/** The block model for `source`. Pure and cached; the result is shared, so never mutate it. */
export function parseMarkdown(source: string): RichBlock[] {
  const cached = cache.get(source);
  if (cached) return cached;
  const blocks: RichBlock[] = [];
  try {
    if ((source.match(INLINE_MARKER)?.length ?? 0) > MAX_INLINE_MARKERS) throw new Error('Too many inline markers to parse.');
    blocksOf(parser.lexer(source.replace(/\r\n?/g, '\n')), 0, [], blocks);
  } catch {
    // The parser is a library; a source it chokes on must still show its words.
    blocks.length = 0;
    blocks.push({ kind: 'text', level: 'body', runs: [{ text: source, style: {} }], indent: 0, frames: [] });
  }
  return cache.set(source, blocks);
}
