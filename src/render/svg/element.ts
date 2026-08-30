/**
 * A minimal SVG element description.
 *
 * Two backends consume it: `toReact` renders the live canvas, `serialize`
 * produces the exported file. Having a single intermediate representation means
 * the canvas and the export are not merely similar — they are the same tree.
 */
export interface SvgEl {
  tag: string;
  attrs?: Record<string, string | number | undefined>;
  children?: SvgEl[];
  /** Text content. Escaped on serialize, passed as a child on render. */
  text?: string;
}

export function el(
  tag: string,
  attrs?: SvgEl['attrs'],
  children?: SvgEl[] | undefined,
  text?: string,
): SvgEl {
  const node: SvgEl = { tag };
  if (attrs) node.attrs = attrs;
  if (children && children.length > 0) node.children = children;
  if (text !== undefined) node.text = text;
  return node;
}

/**
 * XML 1.0 forbids most control characters and lone surrogates. A single one
 * makes the whole document unparseable, which surfaces as a PNG export that
 * silently fails with no error anywhere — so everything user-supplied is
 * scrubbed here, once.
 */
export function stripInvalidXml(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isControl =
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    if (isControl) continue;

    // High surrogate: keep only when correctly paired.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i]! + value[i + 1]!;
        i += 1;
      }
      continue;
    }
    // Unpaired low surrogate.
    if (code >= 0xdc00 && code <= 0xdfff) continue;

    out += value[i];
  }
  return out;
}

export function escapeXmlText(value: string): string {
  return stripInvalidXml(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Serializes a tree to an SVG fragment. Every value is escaped on the way out. */
export function serialize(node: SvgEl): string {
  const attrs = node.attrs
    ? Object.entries(node.attrs)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => ` ${key}="${escapeXmlAttr(String(value))}"`)
        .join('')
    : '';

  const inner =
    (node.text !== undefined ? escapeXmlText(node.text) : '') +
    (node.children ?? []).map(serialize).join('');

  return inner === '' ? `<${node.tag}${attrs}/>` : `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/** Rounds to two decimals: shorter output, and no float noise in test snapshots. */
export function n(value: number): number {
  return Math.round(value * 100) / 100;
}
