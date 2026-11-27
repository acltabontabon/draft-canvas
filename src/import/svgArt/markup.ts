/**
 * The elements and attributes of an SVG file, read as plain data.
 *
 * A picture someone chose is untrusted text. It is not handed to the browser's parser, or to any
 * parser that builds a document: this reads only what a drawing is made from, element names and
 * attribute values, into plain objects. Text between tags, comments, processing instructions and
 * CDATA are stepped over without being kept. There is no document, so nothing here can run, load
 * or be put on a page, and it needs no DOM: it reads the same in a worker, in Node and in a browser.
 *
 * It is strict where XML is: a file that is not well formed is not a picture. It is one pass over
 * the text with no recursion, so a hostile file can cost no more than its own length.
 */

export interface SvgElement {
  /** The element's name without any prefix, as written: `path`, `linearGradient`. */
  readonly name: string;
  /** Attributes by the name they were written with, prefix included: `d`, `xlink:href`. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: SvgElement[];
}

export interface SvgMarkup {
  root: SvgElement;
  /** Every element, the root first, in the order they open. */
  all: SvgElement[];
}

/** A map, not an object: `&constructor;` was once read as what every object inherits under that name. */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;
/** A character a name may start with: a letter, `_` or `:`. Names here are ASCII; anything else is not SVG. */
const startsName = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 58;
const inName = (code: number): boolean => startsName(code) || (code >= 48 && code <= 57) || code === 45 || code === 46;

/** An attribute's value with its character references read. `null` for a reference XML does not define. */
function decoded(raw: string): string | null {
  if (!raw.includes('&')) return raw;
  let out = '';
  let at = 0;
  while (at < raw.length) {
    const amp = raw.indexOf('&', at);
    if (amp < 0) {
      out += raw.slice(at);
      break;
    }
    out += raw.slice(at, amp);
    const end = raw.indexOf(';', amp);
    if (end < 0 || end - amp > 12) return null;
    const name = raw.slice(amp + 1, end);
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const digits = name.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
      const code = parseInt(digits, hex ? 16 : 10);
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return null;
      out += String.fromCodePoint(code);
    } else {
      const value = ENTITIES.get(name);
      if (value === undefined) return null;
      out += value;
    }
    at = end + 1;
  }
  return out;
}

/**
 * `text` as elements. `null` when it is not well-formed markup with one root; `'limit'` when it
 * holds more than `maxElements` elements.
 */
export function readMarkup(text: string, maxElements: number): SvgMarkup | null | 'limit' {
  const all: SvgElement[] = [];
  /** The elements still open, and the name each was opened with, prefix and all. */
  const open: { element: SvgElement; tag: string }[] = [];
  let root: SvgElement | null = null;
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const length = text.length;

  while (at < length) {
    const lt = text.indexOf('<', at);
    // Words between tags are not kept. Outside the root there may be none at all.
    const gap = lt < 0 ? length : lt;
    if (open.length === 0) for (let i = at; i < gap; i += 1) if (!isSpace(text.charCodeAt(i))) return null;
    if (lt < 0) break;
    at = lt + 1;
    const next = text.charCodeAt(at);

    if (next === 63 /* ? */) {
      const end = text.indexOf('?>', at);
      if (end < 0) return null;
      at = end + 2;
      continue;
    }
    if (next === 33 /* ! */) {
      if (text.startsWith('!--', at)) {
        const end = text.indexOf('-->', at + 3);
        if (end < 0) return null;
        at = end + 3;
        continue;
      }
      if (text.startsWith('![CDATA[', at) && open.length > 0) {
        const end = text.indexOf(']]>', at + 8);
        if (end < 0) return null;
        at = end + 3;
        continue;
      }
      // A doctype, an entity, anything else declared: a picture needs none of it.
      return null;
    }
    if (next === 47 /* / */) {
      const end = text.indexOf('>', at);
      if (end < 0) return null;
      const closing = open.pop();
      if (!closing || text.slice(at + 1, end).trimEnd() !== closing.tag) return null;
      at = end + 1;
      continue;
    }

    // An opening tag: a name, then attributes, then `>` or `/>`.
    if (!startsName(next)) return null;
    let end = at + 1;
    while (end < length && inName(text.charCodeAt(end))) end += 1;
    const tag = text.slice(at, end);
    at = end;
    // More than one root is not a document.
    if (open.length === 0 && root) return null;
    const attributes = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      let spaced = false;
      while (at < length && isSpace(text.charCodeAt(at))) {
        at += 1;
        spaced = true;
      }
      if (at >= length) return null;
      const code = text.charCodeAt(at);
      if (code === 62 /* > */) {
        at += 1;
        break;
      }
      if (code === 47 /* / */) {
        if (text.charCodeAt(at + 1) !== 62) return null;
        selfClosing = true;
        at += 2;
        break;
      }
      if (!spaced || !startsName(code)) return null;
      let nameEnd = at + 1;
      while (nameEnd < length && inName(text.charCodeAt(nameEnd))) nameEnd += 1;
      const name = text.slice(at, nameEnd);
      at = nameEnd;
      while (at < length && isSpace(text.charCodeAt(at))) at += 1;
      if (text.charCodeAt(at) !== 61 /* = */) return null;
      at += 1;
      while (at < length && isSpace(text.charCodeAt(at))) at += 1;
      const quote = text.charCodeAt(at);
      if (quote !== 34 && quote !== 39) return null;
      const close = text.indexOf(quote === 34 ? '"' : "'", at + 1);
      if (close < 0) return null;
      const raw = text.slice(at + 1, close);
      at = close + 1;
      const value = raw.includes('<') ? null : decoded(raw);
      if (value === null || attributes.has(name)) return null;
      attributes.set(name, value);
    }

    const colon = tag.lastIndexOf(':');
    const element: SvgElement = { name: colon < 0 ? tag : tag.slice(colon + 1), attributes, children: [] };
    if (element.name === '') return null;
    if (all.length >= maxElements) return 'limit';
    all.push(element);
    const parent = open[open.length - 1];
    if (parent) parent.element.children.push(element);
    else root = element;
    if (!selfClosing) open.push({ element, tag });
  }

  return root && open.length === 0 ? { root, all } : null;
}

/** Everything inside `element`, at any depth, in the order it opens. */
export function descendants(element: SvgElement): SvgElement[] {
  const out: SvgElement[] = [];
  const stack = [...element.children].reverse();
  while (stack.length > 0) {
    const next = stack.pop()!;
    out.push(next);
    for (let i = next.children.length - 1; i >= 0; i -= 1) stack.push(next.children[i]!);
  }
  return out;
}
