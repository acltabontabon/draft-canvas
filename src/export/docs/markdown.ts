/**
 * Markdown, handled only as far as Use in docs needs it: writing one image reference, finding the
 * headings a person can place it under, noticing a reference that is already there, and adding one
 * line to a file without touching anything else in it.
 *
 * There is no Markdown serializer here, on purpose. A file is never parsed into a tree and printed
 * back: the change is computed on the original text, one contiguous block of new characters at one
 * offset, and every other byte — line endings, trailing spaces, odd formatting — is left exactly as
 * it was. The desktop shell checks that again before it writes (`src-tauri/src/docs.rs`).
 */

/** A path as a Markdown link destination: each segment percent-encoded, `/` kept. Spaces, brackets
 *  and parentheses would otherwise end the link early, or turn it into something else. */
export function markdownPath(relative: string): string {
  return relative
    .split('/')
    .map((segment) => (segment === '.' || segment === '..' ? segment : encodeURIComponent(segment).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)))
    .join('/');
}

/** Alt text on one line, with the characters that would close or confuse `![…]` escaped. */
export function escapeAlt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/([\\[\]])/g, '\\$1');
}

/** `![Payments](diagrams/payments.svg)` — the ordinary image syntax every Markdown renderer reads. */
export function markdownImage(alt: string, relative: string): string {
  return `![${escapeAlt(alt)}](${markdownPath(relative)})`;
}

export interface MarkdownHeading {
  /** Zero-based line number in the original text. */
  line: number;
  level: number;
  text: string;
}

interface Line {
  start: number;
  /** Where the line's content ends, before its line ending. */
  end: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const stop = newline < 0 ? text.length : newline;
    const end = stop > start && text[stop - 1] === '\r' ? stop - 1 : stop;
    lines.push({ start, end, text: text.slice(start, end) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/**
 * The ATX headings (`## Architecture`) outside fenced code and front matter. Setext headings
 * (underlined with `===`) are not offered: `---` under a line is just as often a rule, and a wrong
 * guess would put the image somewhere the person didn't pick.
 */
export function headingsOf(text: string): MarkdownHeading[] {
  const lines = linesOf(text);
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  let index = 0;
  if (lines[0]?.text.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && (line.text.trim() === '---' || line.text.trim() === '...'));
    if (close > 0) index = close + 1;
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index]!.text;
    const fenced = FENCE.exec(line);
    if (fenced) {
      const marker = fenced[1]!;
      if (fence === null) fence = marker;
      // A closing fence is the same character, at least as long, and nothing after it: a line like
      // ```js inside a block is the block's text, not its end.
      else if (marker[0] === fence[0] && marker.length >= fence.length && fenced[2]!.trim() === '') fence = null;
      continue;
    }
    if (fence !== null) continue;
    const atx = ATX.exec(line);
    if (atx) headings.push({ line: index, level: atx[1]!.length, text: (atx[2] ?? '').trim() });
  }
  return headings;
}

/** Where the image goes: at the end of the section under a heading, or at the end of the file. */
/**
 * Where the image goes: at the end, under a heading's own text (`section`, by the heading's line),
 * or right after a line (`after`) — another picture of the same diagram, so the levels sit together.
 */
export type Placement = { kind: 'end' } | { kind: 'section'; line: number } | { kind: 'after'; line: number };

const LIKELY_SECTION = /architect|diagram|design|overview|system|structure/i;

/** A heading that sounds like the place for a diagram, or else the end of the file. */
export function defaultPlacement(headings: readonly MarkdownHeading[]): Placement {
  const likely = headings.find((heading) => heading.level > 1 && LIKELY_SECTION.test(heading.text));
  return likely ? { kind: 'section', line: likely.line } : { kind: 'end' };
}

function withoutDotSlash(path: string): string {
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

/**
 * A link destination as written in the Markdown, back to the path it names: a query or fragment
 * dropped (only an unencoded `?` or `#` starts one), then each segment decoded the way
 * `markdownPath` encoded it. `decodeURI` was not enough — it leaves `%26` and `%23` encoded, so a
 * picture called `R&D.svg` never matched its own reference and was added again on every click.
 */
function destinationPath(target: string): string {
  const raw = target.trim().replace(/^<|>$/g, '').split(/[?#]/)[0] ?? '';
  const decoded = raw
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A malformed escape is left as written; it simply won't match.
        return segment;
      }
    })
    .join('/');
  return withoutDotSlash(decoded);
}

const REFERENCE_PATTERNS = [
  /!\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)/g,
  /<(?:img|source)\b[^>]*?\s(?:src|srcset)\s*=\s*["']([^"']+)["']/gi,
  /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm,
];

function referenceOffsets(text: string, relative: string): number[] {
  // `relative` is a plain path (`R&D.svg`, `a#1.svg`), never encoded: only its `./` is dropped.
  const wanted = withoutDotSlash(relative);
  const offsets: number[] = [];
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (destinationPath(match[1] ?? '') === wanted) offsets.push(match.index);
    }
  }
  return offsets.sort((a, b) => a - b);
}

/** How many times `text` already points at `relative` — as an image, an `<img>`, or a reference definition. */
export function referencesTo(text: string, relative: string): number {
  return referenceOffsets(text, relative).length;
}

/** The zero-based line of the first reference to `relative`, or -1. */
export function referenceLine(text: string, relative: string): number {
  const first = referenceOffsets(text, relative)[0];
  return first === undefined ? -1 : text.slice(0, first).split('\n').length - 1;
}

export interface Insertion {
  /** The whole file with the image added. */
  text: string;
  /** Zero-based line of the image in `text`. */
  line: number;
  /** The characters added, and where: `text` is the original with exactly this inserted at `offset`. */
  offset: number;
  inserted: string;
}

/**
 * The file with `snippet` added as its own paragraph — after the chosen heading's own text (before
 * the next heading, whatever its level), right after a chosen line, or at the end. Blank lines
 * around it are added only where there aren't any already, and in the file's own line ending.
 */
export function insertImage(text: string, placement: Placement, snippet: string): Insertion {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = linesOf(text);
  let offset = text.length;
  if (placement.kind === 'section') {
    const headings = headingsOf(text);
    const at = headings.findIndex((heading) => heading.line === placement.line);
    // Right under the chosen heading's own text, before the next heading of any level. Going past
    // its subsections instead put an image chosen for "# Shop" at the very end of most READMEs —
    // the same place as "End of file", which isn't what choosing a heading means.
    const next = at >= 0 ? headings[at + 1] : undefined;
    if (next) offset = lines[next.line]!.start;
  } else if (placement.kind === 'after') {
    const following = lines[placement.line + 1];
    if (following) offset = following.start;
  }

  let inserted: string;
  if (offset === text.length) {
    // At the end: finish an unterminated last line, leave one blank line, then the image.
    const trimmed = text.replace(/[ \t]*$/, '');
    const endsWithEol = text.endsWith('\n');
    const blankBefore = text.length === 0 || /\n[ \t]*\r?\n[ \t]*$/.test(text) || trimmed.length === 0;
    inserted = `${endsWithEol || text.length === 0 ? '' : eol}${blankBefore ? '' : eol}${snippet}${eol}`;
  } else {
    // At the start of a line (a heading's, or the one after the chosen line): a blank line above
    // unless one is there, and one below unless one is there — so a heading stays a heading and a
    // paragraph after doesn't run into the image.
    const before = text.slice(0, offset).replace(/\r?\n$/, '');
    const lastLine = before.slice(before.lastIndexOf('\n') + 1);
    const nextBreak = text.indexOf('\n', offset);
    const nextLine = text.slice(offset, nextBreak < 0 ? text.length : nextBreak);
    inserted = `${lastLine.trim() === '' ? '' : eol}${snippet}${eol}${nextLine.trim() === '' ? '' : eol}`;
  }
  const result = text.slice(0, offset) + inserted + text.slice(offset);
  const imageAt = offset + inserted.indexOf(snippet);
  const line = result.slice(0, imageAt).split('\n').length - 1;
  return { text: result, line, offset, inserted };
}

export interface ExcerptLine {
  text: string;
  /** The line the picture is on: drawn as the picture in a preview. */
  inserted: boolean;
}

/**
 * A few lines either side of the image, for showing the change before it is made — reaching back to
 * the heading of the section it lands in, when that is near, so the excerpt says where it is.
 */
export function excerptAround(text: string, line: number, before = 3, after = 2): ExcerptLine[] {
  const lines = text.split(/\r?\n/);
  let from = Math.max(0, line - before);
  for (let index = from - 1; index >= Math.max(0, line - 8); index -= 1) {
    if (ATX.test(lines[index]!)) {
      from = index;
      break;
    }
  }
  const to = Math.min(lines.length, line + after + 1);
  const excerpt: ExcerptLine[] = [];
  for (let index = from; index < to; index += 1) excerpt.push({ text: lines[index]!, inserted: index === line });
  // A trailing empty line is only the file's last line ending; it says nothing.
  while (excerpt.length > 1 && excerpt[excerpt.length - 1]!.text === '' && !excerpt[excerpt.length - 1]!.inserted) excerpt.pop();
  return excerpt;
}
