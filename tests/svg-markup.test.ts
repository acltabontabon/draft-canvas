// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { importSvgArt } from '../src/import/svgArt';
import { descendants, readMarkup, type SvgElement, type SvgMarkup } from '../src/import/svgArt/markup';

/**
 * The reader an imported SVG goes through instead of a browser parser. It runs here with no DOM at
 * all, which is the point: a chosen picture is never made into a document anywhere.
 */

const read = (text: string, max = 100): SvgMarkup => {
  const markup = readMarkup(text, max);
  if (!markup || markup === 'limit') throw new Error(`not read: ${String(markup)}`);
  return markup;
};
const shape = (element: SvgElement): unknown => [element.name, Object.fromEntries(element.attributes), element.children.map(shape)];

describe('reading SVG markup', () => {
  it('there is no DOM in this run', () => {
    expect(typeof (globalThis as { DOMParser?: unknown }).DOMParser).toBe('undefined');
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });

  it('reads elements, attributes and nesting, and nothing else', () => {
    const { root, all } = read(
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n' +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox='0 0 10 10'>\n  <title>Words are not kept</title>\n` +
        '  <g fill = "red"><path d="M0 0L1 1"/><!-- <rect/> --><![CDATA[ <circle r="1"/> ]]></g>\n  <rect width="2" height="2" />\n</svg>\n<!-- after -->\n',
    );
    expect(shape(root)).toEqual([
      'svg',
      { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 10 10' },
      [
        ['title', {}, []],
        ['g', { fill: 'red' }, [['path', { d: 'M0 0L1 1' }, []]]],
        ['rect', { width: '2', height: '2' }, []],
      ],
    ]);
    expect(all.map((element) => element.name)).toEqual(['svg', 'title', 'g', 'path', 'rect']);
    expect(descendants(root).map((element) => element.name)).toEqual(['title', 'g', 'path', 'rect']);
  });

  it('drops a prefix from an element’s name and keeps an attribute’s', () => {
    const { root } = read('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><svg:use xlink:href="#a"/></svg:svg>');
    expect(root.name).toBe('svg');
    expect(root.children[0]!.name).toBe('use');
    expect(root.children[0]!.attributes.get('xlink:href')).toBe('#a');
  });

  it('reads the character references XML defines, and no others', () => {
    const { root } = read('<svg a="&lt;&amp;&gt;&quot;&apos;" b="&#65;&#x42;" c=\'"\'/>');
    expect(Object.fromEntries(root.attributes)).toEqual({ a: '<&>"\'', b: 'AB', c: '"' });
    for (const bad of ['<svg a="&nbsp;"/>', '<svg a="&#0;"/>', '<svg a="&#xD800;"/>', '<svg a="&#x110000;"/>', '<svg a="&amp"/>', '<svg a="&#;"/>']) expect(readMarkup(bad, 10), bad).toBeNull();
  });

  it('refuses anything that is not well formed', () => {
    const bad = [
      '',
      'plain words',
      '<svg>',
      '<svg></g>',
      '<svg><g></svg></g>',
      '<svg/><svg/>',
      'x<svg/>',
      '<svg/>x',
      '<svg a="1" a="2"/>',
      '<svg a=1/>',
      '<svg a/>',
      '<svg a="<"/>',
      '<svg a="1"b="2"/>',
      '<svg a="1/>',
      '<svg / >',
      '< svg/>',
      '<svg><1/></svg>',
      '<svg><!-- never closed</svg>',
      '<svg><![CDATA[ never closed</svg>',
      '<?xml never closed',
      '<![CDATA[x]]><svg/>',
      '<!DOCTYPE svg><svg/>',
      '<svg><!ENTITY a "b"></svg>',
      '<svg><script>if (a < b) run()</script></svg>',
      '<:/>',
    ];
    for (const text of bad) expect(readMarkup(text, 10), JSON.stringify(text)).toBeNull();
  });

  it('stops at the number of elements it was given, and is not troubled by depth', () => {
    expect(readMarkup(`<svg>${'<g/>'.repeat(9)}</svg>`, 10)).not.toBe('limit');
    expect(readMarkup(`<svg>${'<g/>'.repeat(10)}</svg>`, 10)).toBe('limit');
    const deep = 50_000;
    const nested = read(`${'<g>'.repeat(deep)}${'</g>'.repeat(deep)}`, deep);
    expect(nested.all).toHaveLength(deep);
    expect(descendants(nested.root)).toHaveLength(deep - 1);
  });
});

describe('importing a picture with no DOM', () => {
  it('makes the same drawing it makes in a browser', () => {
    const result = importSvgArt(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)"><script>alert(1)</script>' +
        '<defs><linearGradient id="g"><stop stop-color="#ff0000"/></linearGradient><path id="p" d="M10 10H90V90H10Z"/></defs>' +
        '<use href="#p" fill="url(#g)"/><circle cx="50" cy="50" r="20" style="fill:#00ff00;stroke:#000;stroke-width:4"/>' +
        '<image href="https://example.test/x.png" width="5" height="5"/><text>hello</text></svg>',
      'original',
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.asset.paths.map((path) => [path.fill, path.stroke, path.sw])).toEqual([
      ['#ff0000', undefined, undefined],
      ['#00ff00', '#000000', 4],
    ]);
    expect(result.notes.join(' ')).toMatch(/left out/);
    expect(JSON.stringify(result.asset)).not.toMatch(/script|alert|onload|https?:|hello/);
  });

  it('refuses what is not a picture, deeply nested or not', () => {
    expect(importSvgArt('<html><body/></html>')).toMatchObject({ ok: false });
    expect(importSvgArt('<svg><path d="M0 0L1 1"></svg>')).toMatchObject({ ok: false });
    const deep = `<svg>${'<g>'.repeat(1_500)}<path d="M0 0H9V9Z"/>${'</g>'.repeat(1_500)}</svg>`;
    expect(importSvgArt(deep)).toMatchObject({ ok: false });
    expect(importSvgArt(`<svg>${'<g/>'.repeat(2_000)}</svg>`)).toMatchObject({ ok: false, message: expect.stringMatching(/too detailed/) });
  });
});
