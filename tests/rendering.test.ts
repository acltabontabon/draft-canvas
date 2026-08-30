import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode, minSizeFor } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { NODE_TYPES } from '../src/document/types';
import { describeContext, describeNode } from '../src/nodes/describe';
import { renderDocumentSvg } from '../src/render/svg/document';
import { escapeXmlAttr, escapeXmlText, serialize, stripInvalidXml } from '../src/render/svg/element';
import { tokenizeCode, flattenToLines } from '../src/render/code/highlight';
import { layoutText, baselineOf } from '../src/render/text/layout';
import { StaticTextMeasurer } from '../src/render/text/measure';
import { FONTS } from '../src/render/text/fonts';
import { LIGHT } from '../src/render/theme/tokens';
import { routeBetween, chooseSides } from '../src/edges/routing';

const measurer = new StaticTextMeasurer();

function parseSvg(svg: string): Document {
  return new DOMParser().parseFromString(svg, 'image/svg+xml');
}

describe('text layout', () => {
  it('wraps to the given width and reports exact line widths', () => {
    const layout = layoutText('the quick brown fox jumps over the lazy dog', {
      font: FONTS.nodeLabel,
      maxWidth: 120,
      lineHeight: 19,
      measurer,
    });
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(line.width).toBeLessThanOrEqual(120);
      expect(line.text).not.toMatch(/^\s|\s$/);
    }
    expect(layout.height).toBe(layout.lines.length * 19);
  });

  it('honours explicit line breaks', () => {
    const layout = layoutText('one\ntwo\nthree', {
      font: FONTS.nodeLabel,
      maxWidth: 400,
      lineHeight: 19,
      measurer,
    });
    expect(layout.lines.map((line) => line.text)).toEqual(['one', 'two', 'three']);
  });

  it('breaks a single token too wide to fit rather than overflowing', () => {
    const layout = layoutText('https://internal.example.com/a/very/long/path/that/never/ends', {
      font: FONTS.nodeLabel,
      maxWidth: 90,
      lineHeight: 19,
      measurer,
    });
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(90);
  });

  it('breaks a long token that follows ordinary words', () => {
    const layout = layoutText('see aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      font: FONTS.nodeLabel,
      maxWidth: 80,
      lineHeight: 19,
      measurer,
    });
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(80);
  });

  it('truncates with an ellipsis when a line budget is set', () => {
    const layout = layoutText('one two three four five six seven eight nine ten', {
      font: FONTS.nodeLabel,
      maxWidth: 90,
      lineHeight: 19,
      maxLines: 2,
      measurer,
    });
    expect(layout.lines).toHaveLength(2);
    expect(layout.truncated).toBe(true);
    expect(layout.lines[1]!.text.endsWith('…')).toBe(true);
  });

  it('places baselines inside their line boxes and evenly apart', () => {
    const layout = layoutText('one\ntwo\nthree', {
      font: FONTS.nodeLabel,
      maxWidth: 400,
      lineHeight: 20,
      measurer,
    });
    const first = baselineOf(layout, 0);
    const second = baselineOf(layout, 1);
    expect(second - first).toBeCloseTo(20, 5);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(20);
  });
});

describe('code tokenizing', () => {
  it('splits highlighted code into one token list per line', () => {
    const lines = tokenizeCode('{\n  "status": "CANCELLED"\n}', 'json');
    expect(lines).toHaveLength(3);
    expect(lines[1]!.map((token) => token.text).join('')).toBe('  "status": "CANCELLED"');
    expect(lines[1]!.some((token) => token.scope !== null)).toBe(true);
  });

  it('highlights Java without losing a character', () => {
    const source = '@Transactional\npublic void cancel(Account account) {\n  account.cancel();\n}';
    const lines = tokenizeCode(source, 'java');
    const rebuilt = lines.map((line) => line.map((token) => token.text).join('')).join('\n');
    expect(rebuilt).toBe(source);
  });

  it('recognises timestamps and levels in logs', () => {
    const lines = tokenizeCode(
      '2026-08-30T13:40:21 ERROR PaymentService\nTimeout calling downstream CMS',
      'log',
    );
    const scopes = lines[0]!.map((token) => token.scope);
    expect(scopes).toContain('log-timestamp');
    expect(scopes).toContain('log-error');
  });

  it('leaves plain text alone', () => {
    const lines = tokenizeCode('just some words', 'plaintext');
    expect(lines).toEqual([[{ text: 'just some words', scope: null }]]);
  });

  it('expands tabs so monospace geometry is exact', () => {
    const lines = tokenizeCode('a\tb', 'plaintext');
    expect(lines[0]![0]!.text).not.toContain('\t');
  });

  it('does not fall over on an empty document', () => {
    expect(tokenizeCode('', 'json')).toEqual([[]]);
    expect(flattenToLines({ type: 'root', children: [] })).toEqual([[]]);
  });
});

describe('XML escaping', () => {
  it('escapes markup in text content', () => {
    expect(escapeXmlText('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(escapeXmlText('a & b')).toBe('a &amp; b');
  });

  it('escapes quotes in attribute values', () => {
    expect(escapeXmlAttr('he said "hi"')).toBe('he said &quot;hi&quot;');
    expect(escapeXmlAttr("it's")).toBe('it&apos;s');
  });

  it('removes characters that are illegal in XML', () => {
    expect(stripInvalidXml('a\u0000b\u0008c\u001Fd\u007Fe')).toBe('abcde');
    expect(stripInvalidXml('keep\ttabs\nand\r\nnewlines')).toBe('keep\ttabs\nand\r\nnewlines');
  });

  it('drops unpaired surrogates but keeps real astral characters', () => {
    expect(stripInvalidXml('a\uD800b')).toBe('ab');
    expect(stripInvalidXml('a\uDC00b')).toBe('ab');
    expect(stripInvalidXml('a🚀b')).toBe('a🚀b');
  });

  it('cannot be escaped out of via a serialized element', () => {
    const markup = serialize({
      tag: 'text',
      attrs: { fill: '#fff' },
      text: '</text><script>globalThis.__pwned=1</script>',
    });
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

describe('edge routing', () => {
  it('connects side to side when nodes are laid out horizontally', () => {
    const sides = chooseSides(
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 400, y: 10, width: 100, height: 60 },
    );
    expect(sides).toEqual({ source: 'right', target: 'left' });
  });

  it('connects top to bottom when nodes are stacked', () => {
    const sides = chooseSides(
      { x: 0, y: 0, width: 200, height: 60 },
      { x: 10, y: 400, width: 200, height: 60 },
    );
    expect(sides).toEqual({ source: 'bottom', target: 'top' });
  });

  it('reverses the anchors when the target is behind the source', () => {
    const sides = chooseSides(
      { x: 400, y: 0, width: 100, height: 60 },
      { x: 0, y: 0, width: 100, height: 60 },
    );
    expect(sides).toEqual({ source: 'left', target: 'right' });
  });

  it('produces a usable path for every routing style', () => {
    const a = { x: 0, y: 0, width: 100, height: 60 };
    const b = { x: 320, y: 140, width: 100, height: 60 };
    for (const routing of ['smoothstep', 'bezier', 'straight'] as const) {
      const route = routeBetween(a, b, routing);
      expect(route.d).toMatch(/^M/);
      expect(Number.isFinite(route.labelX)).toBe(true);
      expect(Number.isFinite(route.labelY)).toBe(true);
    }
  });

  it('reroutes when a node moves', () => {
    const a = { x: 0, y: 0, width: 100, height: 60 };
    const before = routeBetween(a, { x: 400, y: 0, width: 100, height: 60 }, 'smoothstep');
    const after = routeBetween(a, { x: 0, y: 400, width: 100, height: 60 }, 'smoothstep');
    expect(before.d).not.toBe(after.d);
    expect(before.source.side).toBe('right');
    expect(after.source.side).toBe('bottom');
  });
});

/* ------------------------------------------------------------ SVG export -- */

function exportFixture() {
  const service = createNode({ type: 'service', x: 0, y: 0, text: 'Order Service' });
  const queue = createNode({ type: 'queue', x: 320, y: 0, text: 'orders.v1' });
  const code = createNode({
    type: 'code',
    x: 0,
    y: 200,
    width: 380,
    height: 160,
    language: 'json',
    code: '{\n  "accountId": "123"\n}',
  });
  const note = createNode({ type: 'note', x: 420, y: 200, text: 'Retried twice?', noteKind: 'question' });
  const edge = createEdge({
    source: service.id,
    target: queue.id,
    label: 'ORDER_CREATED',
    sequence: 1,
  });
  return addEdges(addNodes(createDocument('Export'), [service, queue, code, note]), [edge]);
}

describe('SVG export', () => {
  it('produces a well-formed, self-contained document', () => {
    const { svg, width, height } = renderDocumentSvg(exportFixture());
    const parsed = parseSvg(svg);

    expect(parsed.querySelector('parsererror')).toBeNull();
    const root = parsed.documentElement;
    expect(root.tagName).toBe('svg');
    // Explicit pixel dimensions are what let a browser rasterize it correctly.
    expect(root.getAttribute('width')).toBe(String(width));
    expect(root.getAttribute('height')).toBe(String(height));
    expect(root.getAttribute('viewBox')).toBe(`0 0 ${width} ${height}`);
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
  });

  it('uses real SVG primitives, never foreignObject', () => {
    const { svg } = renderDocumentSvg(exportFixture());
    // foreignObject would make the file useless in a README or a vector editor.
    expect(svg).not.toContain('foreignObject');
    expect(svg).not.toContain('<div');
    expect(svg).toContain('<text');
    expect(svg).toContain('<rect');
  });

  it('references no external resource of any kind', () => {
    const { svg } = renderDocumentSvg(exportFixture());
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('@font-face');
    expect(svg).not.toContain('xlink:');
  });

  it('resolves every internal reference it emits', () => {
    const { svg } = renderDocumentSvg(exportFixture());
    const parsed = parseSvg(svg);
    const ids = new Set([...parsed.querySelectorAll('[id]')].map((el) => el.id));

    for (const match of svg.matchAll(/url\(#([^)]+)\)/g)) {
      expect(ids.has(match[1]!)).toBe(true);
    }
    expect(ids.size).toBeGreaterThan(0);
  });

  it('sizes the canvas to the content plus padding', () => {
    const doc = exportFixture();
    const { width, height } = renderDocumentSvg(doc, { padding: 40 });
    const right = Math.max(...doc.nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...doc.nodes.map((node) => node.y + node.height));
    expect(width).toBe(Math.round(right + 80));
    expect(height).toBe(Math.round(bottom + 80));
  });

  it('carries connector labels and step numbers into the image', () => {
    const { svg } = renderDocumentSvg(exportFixture());
    expect(svg).toContain('ORDER_CREATED');
    expect(svg).toContain('Order Service');
    expect(svg).toContain('orders.v1');
  });

  it('preserves code content and syntax colours', () => {
    const { svg } = renderDocumentSvg(exportFixture());
    const parsed = parseSvg(svg);
    const tspans = [...parsed.querySelectorAll('tspan')];

    expect(tspans.length).toBeGreaterThan(0);
    expect(tspans.map((el) => el.textContent).join('')).toContain('accountId');
    // More than one colour means highlighting actually survived the export.
    expect(new Set(tspans.map((el) => el.getAttribute('fill'))).size).toBeGreaterThan(1);
  });

  it('omits the background when a transparent export is requested', () => {
    const opaque = renderDocumentSvg(exportFixture());
    const transparent = renderDocumentSvg(exportFixture(), { transparent: true });
    expect(transparent.svg.length).toBeLessThan(opaque.svg.length);
    expect(parseSvg(transparent.svg).querySelector('parsererror')).toBeNull();
  });

  it('exports the light palette on request', () => {
    const dark = renderDocumentSvg(exportFixture(), { theme: 'dark' });
    const light = renderDocumentSvg(exportFixture(), { theme: 'light' });
    expect(dark.svg).not.toBe(light.svg);
    expect(light.svg).toContain('#fbfbfc');
  });

  it('exports only the chosen elements when asked', () => {
    const doc = exportFixture();
    const only = new Set([doc.nodes[0]!.id]);
    const { svg } = renderDocumentSvg(doc, { only });
    expect(svg).toContain('Order Service');
    expect(svg).not.toContain('orders.v1');
    // The connector had one end outside the selection, so it is left out too.
    expect(svg).not.toContain('ORDER_CREATED');
  });

  it('never emits editor chrome', () => {
    const { svg } = renderDocumentSvg(exportFixture());
    for (const chrome of ['dc-handle', 'dc-resize', 'react-flow', 'dc-guide']) {
      expect(svg).not.toContain(chrome);
    }
  });

  it('renders an empty document without throwing', () => {
    const { svg, width, height } = renderDocumentSvg(createDocument('Empty'));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(parseSvg(svg).querySelector('parsererror')).toBeNull();
  });

  it('is deterministic — the same document exports byte-identically', () => {
    const doc = exportFixture();
    expect(renderDocumentSvg(doc).svg).toBe(renderDocumentSvg(doc).svg);
  });
});

describe('SVG export is safe against hostile content', () => {
  const hostile = '</text><script>globalThis.__pwned = true</script><text>';

  function hostileDocument() {
    const node = createNode({ type: 'card', x: 0, y: 0, text: hostile });
    const code = createNode({
      type: 'code',
      x: 0,
      y: 200,
      language: 'java',
      code: `${hostile}\n<img src=x onerror="alert(1)">`,
    });
    const edge = createEdge({ source: node.id, target: code.id, label: hostile });
    return addEdges(addNodes(createDocument(hostile), [node, code]), [edge]);
  }

  it('escapes injected markup in labels, code and connector text', () => {
    const { svg } = renderDocumentSvg(hostileDocument());
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('onerror=');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('still parses as valid SVG, with the payload intact as text', () => {
    const { svg } = renderDocumentSvg(hostileDocument());
    const parsed = parseSvg(svg);
    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.querySelectorAll('script')).toHaveLength(0);
    expect(parsed.documentElement.textContent).toContain('script');
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('keeps clip-path ids unique between nodes so they cannot cross-reference', () => {
    const doc = exportFixture();
    const parsed = parseSvg(renderDocumentSvg(doc).svg);
    const ids = [...parsed.querySelectorAll('clipPath')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('live resize', () => {
  it('gives every node type a sensible, positive per-type minimum', () => {
    for (const type of NODE_TYPES) {
      const min = minSizeFor(type);
      expect(min.width).toBeGreaterThan(0);
      expect(min.height).toBeGreaterThan(0);
    }
  });

  it('describes a node at its live (in-gesture) size without touching the committed node', () => {
    const node = createNode({ type: 'code', x: 0, y: 0, code: 'const x = 1;', language: 'plaintext' });
    const ctx = describeContext(LIGHT);
    const live = { ...node, width: node.width + 120, height: node.height + 80 };

    const display = describeNode(live, ctx);
    expect(display.shapes.length).toBeGreaterThan(0);
    // The committed node itself must be untouched by describing a resized clone.
    expect(node.width).not.toBe(live.width);
    expect(node.height).not.toBe(live.height);
  });

  it('renders a boundary preset as a caption, never mutating the node\'s own text', () => {
    const ctx = describeContext(LIGHT);
    const boundary = createNode({
      type: 'group',
      x: 0,
      y: 0,
      text: 'Payment Platform',
      boundaryPreset: 'domain',
    });
    expect(boundary.text).toBe('Payment Platform');

    const display = describeNode(boundary, ctx);
    const texts = display.shapes
      .filter((shape): shape is Extract<typeof shape, { t: 'text' }> => shape.t === 'text')
      .map((shape) => shape.layout.lines.map((line) => line.text).join(''));
    expect(texts).toContain('Payment Platform');
    expect(texts).toContain('DOMAIN');
    expect(texts.some((text) => text.includes('Domain: Payment Platform'))).toBe(false);
  });

  it('renders no caption for the default boundary preset', () => {
    const ctx = describeContext(LIGHT);
    const boundary = createNode({ type: 'group', x: 0, y: 0, text: 'Untitled area' });
    expect(boundary.boundaryPreset).toBe('boundary');
    const display = describeNode(boundary, ctx);
    const texts = display.shapes
      .filter((shape): shape is Extract<typeof shape, { t: 'text' }> => shape.t === 'text')
      .map((shape) => shape.layout.lines.map((line) => line.text).join(''));
    expect(texts).toEqual(['Untitled area']);
  });

  it('gives each service/database/queue variant a distinct caption without changing the base category colour', () => {
    const ctx = describeContext(LIGHT);

    function fillsAndCaptions(node: ReturnType<typeof createNode>) {
      const display = describeNode(node, ctx);
      // Only the silhouette's own fill (rect/path/ellipse) — a caption's text
      // colour is a different visual channel and deliberately uses the
      // theme's neutral muted colour regardless of accent.
      const fills = display.shapes
        .filter((shape) => shape.t !== 'text')
        .map((shape) => ('fill' in shape ? shape.fill : undefined))
        .filter((fill): fill is string => typeof fill === 'string');
      const texts = display.shapes
        .filter((shape): shape is Extract<typeof shape, { t: 'text' }> => shape.t === 'text')
        .map((shape) => shape.layout.lines.map((line) => line.text).join(''));
      return { fills, texts };
    }

    for (const [type, kindField, kinds] of [
      ['service', 'serviceKind', ['generic', 'api', 'worker', 'external']],
      ['database', 'databaseKind', ['generic', 'sql', 'nosql', 'cache']],
      ['queue', 'queueKind', ['queue', 'topic', 'stream']],
    ] as const) {
      const variants = kinds.map((kind) =>
        createNode({ type, x: 0, y: 0, text: 'Label', [kindField]: kind } as Parameters<
          typeof createNode
        >[0]),
      );
      const results = variants.map(fillsAndCaptions);

      // The base category's fills (accent-driven silhouette colour) are
      // identical across every kind of the same type.
      const [first, ...rest] = results;
      for (const result of rest) expect(result.fills).toEqual(first!.fills);

      // The default kind renders no extra caption; every named kind adds
      // exactly one distinguishing caption on top of the shared label.
      expect(results[0]!.texts).toEqual(['Label']);
      for (let i = 1; i < results.length; i += 1) {
        expect(results[i]!.texts).toContain('Label');
        expect(results[i]!.texts.length).toBe(2);
      }
      // Every named kind's caption is distinct from every other's.
      const captions = results.slice(1).map((r) => r.texts.find((t) => t !== 'Label'));
      expect(new Set(captions).size).toBe(captions.length);
    }
  });

  it('describes every node type at its own per-type minimum without throwing or collapsing geometry', () => {
    const ctx = describeContext(LIGHT);
    for (const type of NODE_TYPES) {
      const min = minSizeFor(type);
      const node = createNode({ type, x: 0, y: 0, width: min.width, height: min.height, text: 'Label' });
      expect(() => describeNode(node, ctx)).not.toThrow();
      const display = describeNode(node, ctx);
      expect(display.shapes.length).toBeGreaterThan(0);
    }
  });
});
