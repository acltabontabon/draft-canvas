import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/agent/compile';
import { AgentError } from '../src/agent/errors';
import { applyUpdate } from '../src/agent/patch';
import { readDiagram } from '../src/agent/read';
import {
  colorSpan,
  continueOnEnter,
  indentLines,
  insertBlock,
  insertLink,
  toggleInline,
  toggleLines,
  type SourceEdit,
} from '../src/canvas/markdownEditing';
import { displayNameFor } from '../src/document/factory';
import { plainTextOfMarkdown } from '../src/document/markdownText';
import { escapeLegacyText, migrateToCurrent } from '../src/document/migrate';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { deserializeDocument } from '../src/export/project';
import { describeContext, describeNode, naturalTextHeight, naturalTextSize } from '../src/nodes/describe';
import type { Shape } from '../src/render/displayList';
import { emitDisplayList } from '../src/render/svg/emit';
import { serialize } from '../src/render/svg/element';
import { layoutRichText } from '../src/render/text/layout';
import { parseMarkdown, type Inline, type RichBlock } from '../src/render/text/markdown';
import { FONTS, LINE_HEIGHTS } from '../src/render/text/fonts';
import { THEMES } from '../src/render/theme/tokens';

const words = (runs: Inline[]) => runs.map((run) => ('break' in run ? '\n' : run.text)).join('');
const textBlocks = (source: string) => parseMarkdown(source).filter((b): b is Extract<RichBlock, { kind: 'text' }> => b.kind === 'text');

describe('Markdown model', () => {
  it('reads headings, emphasis, code, highlights, links and coloured spans', () => {
    const [heading, body] = textBlocks('# Orders **API**\nSome _it_ ~~gone~~ `id` ==hot== [docs](https://x.dev) [risky]{.rose}');
    expect(heading).toMatchObject({ level: 'h1' });
    expect(heading!.runs.find((run) => !('break' in run) && run.text === 'API')).toMatchObject({ style: { bold: true } });
    const style = (text: string) => body!.runs.find((run): run is Exclude<Inline, { break: true }> => !('break' in run) && run.text === text)?.style;
    expect(style('it')).toEqual({ italic: true });
    expect(style('gone')).toEqual({ strike: true });
    expect(style('id')).toEqual({ code: true });
    expect(style('hot')).toEqual({ mark: true });
    expect(style('docs')).toEqual({ link: true });
    expect(style('risky')).toEqual({ color: 'rose' });
  });

  it('a single newline is a line break, the way every text box in the app behaves', () => {
    const [block] = textBlocks('one\ntwo');
    expect(block!.runs).toContainEqual({ break: true });
  });

  it('flattens lists with their markers, nesting and tasks', () => {
    const blocks = textBlocks('- a\n  - b\n1. one\n2. two\n- [x] done\n- [ ] todo');
    expect(blocks.map((b) => [words(b.runs), b.marker, b.indent])).toEqual([
      ['a', { kind: 'bullet', depth: 0 }, 0],
      ['b', { kind: 'bullet', depth: 1 }, 1],
      ['one', { kind: 'number', value: 1 }, 0],
      ['two', { kind: 'number', value: 2 }, 0],
      ['done', { kind: 'task', checked: true }, 0],
      ['todo', { kind: 'task', checked: false }, 0],
    ]);
  });

  it('turns GitHub alerts into callouts with a title, and keeps a plain quote a quote', () => {
    const blocks = parseMarkdown('> [!WARNING]\n> Careful\n\n> just quoted');
    expect(blocks[0]).toMatchObject({ kind: 'text', callout: 'warning' });
    expect(words((blocks[0] as Extract<RichBlock, { kind: 'text' }>).runs)).toBe('Warning');
    expect(blocks[1]!.frames[0]).toMatchObject({ kind: 'callout', callout: 'warning' });
    expect(words((blocks[1] as Extract<RichBlock, { kind: 'text' }>).runs)).toBe('Careful');
    expect(blocks[2]!.frames[0]).toMatchObject({ kind: 'quote' });
  });

  it('reads fenced code with its language, tables and dividers', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;\n```\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |\n\n---');
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'ts', code: 'const a = 1;' });
    expect(blocks[1]).toMatchObject({ kind: 'table', align: [null, 'right'] });
    expect(blocks[2]).toMatchObject({ kind: 'rule' });
  });

  it('shows raw HTML and indented lines as typed — never as markup or a code block', () => {
    expect(words(textBlocks('<script>alert(1)</script>')[0]!.runs)).toBe('<script>alert(1)</script>');
    const [indented] = parseMarkdown('    four spaces in');
    expect(indented).toMatchObject({ kind: 'text' });
  });

  it('decodes entities written as text', () => {
    expect(words(textBlocks('a &amp; b &lt; c &#x2192; d')[0]!.runs)).toBe('a & b < c → d');
  });
});

describe('Rich layout', () => {
  const options = { font: FONTS.freeText, maxWidth: 240, lineHeightRatio: LINE_HEIGHTS.body };

  it('wraps styled runs within the width and sets headings taller than body text', () => {
    const layout = layoutRichText('# Heading\nA sentence long enough to wrap across more than one line in this box.', options);
    expect(layout.lines.length).toBeGreaterThan(2);
    for (const line of layout.lines) expect(line.left + line.width).toBeLessThanOrEqual(240 + 0.01);
    expect(layout.lines[0]!.height).toBeGreaterThan(layout.lines[1]!.height);
  });

  it('keeps a bold word glued to the punctuation after it', () => {
    const layout = layoutRichText('**bold**, then more words to fill the line', { ...options, maxWidth: 60 });
    const first = layout.lines[0]!.runs.map((run) => run.text).join('');
    expect(first.startsWith('bold,')).toBe(true);
  });

  it('lays a code block out as a box that never wraps its lines', () => {
    const layout = layoutRichText('```ts\nconst aVeryLongIdentifierName = somethingElse.thatGoes.onAndOn();\n```', options);
    const box = layout.boxes.find((b) => b.kind === 'code');
    expect(box).toMatchObject({ kind: 'code', lang: 'ts', visibleLines: 1 });
    expect(layout.naturalWidth).toBeGreaterThan(240);
  });

  it('cuts what does not fit the height and says so', () => {
    const full = layoutRichText('one\ntwo\nthree\nfour', options);
    const cut = layoutRichText('one\ntwo\nthree\nfour', { ...options, maxHeight: full.height / 2 });
    expect(cut.truncated).toBe(true);
    expect(cut.lines.length).toBeLessThan(full.lines.length);
    expect(cut.lines.at(-1)!.runs.at(-1)!.text.endsWith('…')).toBe(true);
  });
});

describe('Text element drawing', () => {
  const ctx = describeContext(THEMES.light, 'clean');
  const node = (overrides: Partial<DraftNode> = {}): DraftNode => ({ id: 't', type: 'text', x: 0, y: 0, z: 0, width: 260, height: 400, text: 'x', ...overrides });
  const flat = (shapes: Shape[]): Shape[] => shapes.flatMap((s) => (s.t === 'group' ? [s, ...flat(s.children)] : [s]));

  it('draws the canvas and the export from one display list: runs as positioned tspans', () => {
    const list = describeNode(node({ text: 'Plain **bold** `code`' }), ctx);
    const svg = emitDisplayList(list).map(serialize).join('');
    expect(svg).toContain('<tspan');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('ui-monospace');
  });

  it('escapes what was typed: Markdown never becomes markup in the SVG', () => {
    const svg = emitDisplayList(describeNode(node({ text: '<img src=x onerror=alert(1)> **<b>**' }), ctx)).map(serialize).join('');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;img');
  });

  it('highlights a fenced block with the code card\'s own highlighter, and tints a diff', () => {
    const shapes = flat(describeNode(node({ text: '```diff\n- old\n+ new\n```' }), ctx).shapes);
    const code = shapes.find((s) => s.t === 'code');
    expect(code).toBeDefined();
    expect(shapes.filter((s) => s.t === 'rect' && s.opacity === 0.12)).toHaveLength(2);
  });

  it('draws a card, a banner and a marker behind the words in the element\'s colour', () => {
    const card = describeNode(node({ text: 'Hi', textBackground: 'card', accent: 'teal' }), ctx).shapes;
    expect(card[0]).toMatchObject({ fill: THEMES.light.accents.teal.fill });
    const marker = describeNode(node({ text: 'Hi\nthere', textBackground: 'marker' }), ctx).shapes;
    expect(marker.filter((s) => s.t === 'rect' && s.opacity !== undefined)).toHaveLength(2);
    const banner = describeNode(node({ text: 'Hi', textBackground: 'banner', accent: 'violet' }), ctx).shapes;
    const rich = banner.find((s) => s.t === 'rich');
    expect(rich && rich.t === 'rich' && rich.lines[0]!.runs[0]!.fill).toBe(THEMES.light.canvas);
  });

  it('sizes itself from what the Markdown renders as, padding included', () => {
    const plain = naturalTextHeight({ width: 260 }, '# Title\nbody', ctx);
    const carded = naturalTextHeight({ width: 260, textBackground: 'card' }, '# Title\nbody', ctx);
    expect(carded).toBeGreaterThan(plain);
    const wide = naturalTextSize({}, '```ts\nconst somethingQuiteLong = callAFunction(withArguments, andMore, andMore);\n```', ctx, { width: 40, height: 20 });
    expect(wide.width).toBeGreaterThan(320);
  });
});

describe('Plain words for names, search and other formats', () => {
  it('drops the formatting and keeps every word', () => {
    expect(plainTextOfMarkdown('# Orders **API**\n- [x] `retry` with ==backoff==\n> [!NOTE]\n> see [docs](https://x)\n[hot]{.rose}')).toBe(
      'Orders API\nretry with backoff\n\nsee docs\nhot',
    );
  });

  it('names a Text element by its words, not its syntax', () => {
    expect(displayNameFor({ type: 'text', text: '## Checkout' })).toBe('Checkout');
  });
});

describe('v21: plain text written before Markdown reads the same', () => {
  const plainOf = (source: string) =>
    parseMarkdown(source)
      .map((block) => (block.kind === 'text' ? words(block.runs) : `<${block.kind}>`))
      .join('\n');

  it('escapes what Markdown would act on, so the words come out exactly as typed', () => {
    for (const legacy of ['- not a list', '# not a heading', '1. not numbered', 'a *b* _c_ `d` ~~e~~ ==f==', '> not quoted', '---', '| a | b |', 'https://example.com', '[x]{.rose} [y](z)', 'C:\\path\\to']) {
      expect(plainOf(escapeLegacyText(legacy))).toBe(legacy);
    }
  });

  it('keeps indentation and blank lines', () => {
    expect(plainOf(escapeLegacyText('top\n\n    indented'))).toBe('top\n\u00a0\n\u00a0\u00a0\u00a0\u00a0indented');
  });

  it('holds for any text a person could have typed', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...'ab -*_#>`~=[]()!|\\:/.1{}\n') }), (legacy) => {
        // Every word and mark as typed; only what Markdown never showed anyway differs \u2014 spaces at a
        // line's end \u2014 and the indentation and blank lines `escapeLegacyText` holds open on purpose.
        const expected = legacy
          .split('\n')
          .map((line) => (line.trim() === '' ? '\u00a0' : line.replace(/^ +/, (spaces) => '\u00a0'.repeat(spaces.length)).replace(/ +$/, '')))
          .join('\n');
        expect(plainOf(escapeLegacyText(legacy)).replace(/ +$/gm, '')).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('migrates Text nodes and Text attachments in every room, and nothing else', () => {
    const { doc } = migrateToCurrent({
      version: 20,
      nodes: [
        { id: 't', type: 'text', text: '- item' },
        { id: 'n', type: 'note', text: '- item' },
        { id: 's', type: 'service', text: 'A', attachments: [{ id: 'a', type: 'text', text: '*x*' }], inside: { nodes: [{ id: 'i', type: 'text', text: '# h' }], edges: [], flows: [] } },
      ],
      edges: [],
      flows: [],
    });
    const nodes = doc.nodes as { text?: string; attachments: { text: string }[]; inside: { nodes: { text: string }[] } }[];
    expect(nodes[0]!.text).toBe('\\- item');
    expect(nodes[1]!.text).toBe('- item');
    expect(nodes[2]!.attachments[0]!.text).toBe('\\*x\\*');
    expect(nodes[2]!.inside.nodes[0]!.text).toBe('\\# h');
  });
});

describe('Format bar edits', () => {
  const apply = (value: string, edit: SourceEdit) => {
    const next = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
    return { value: next, selected: next.slice(edit.start, edit.end) };
  };

  it('wraps and unwraps a selection, leaving its outer spaces outside the marks', () => {
    const wrapped = apply('make this bold', toggleInline({ value: 'make this bold', start: 4, end: 9 }, 'bold'));
    expect(wrapped).toEqual({ value: 'make **this** bold', selected: 'this' });
    const unwrapped = apply(wrapped.value, toggleInline({ value: wrapped.value, start: 7, end: 11 }, 'bold'));
    expect(unwrapped.value).toBe('make this bold');
  });

  it('turns lines into a list and back, numbering them', () => {
    const listed = apply('a\nb', toggleLines({ value: 'a\nb', start: 0, end: 3 }, 'number'));
    expect(listed.value).toBe('1. a\n2. b');
    expect(apply(listed.value, toggleLines({ value: listed.value, start: 0, end: listed.value.length }, 'number')).value).toBe('a\nb');
    expect(apply('- a', toggleLines({ value: '- a', start: 3, end: 3 }, 'task')).value).toBe('- [ ] a');
  });

  it('continues a list on Enter, and ends it on an empty item', () => {
    expect(apply('1. one', continueOnEnter({ value: '1. one', start: 6, end: 6 })!).value).toBe('1. one\n2. ');
    expect(apply('- [x] done', continueOnEnter({ value: '- [x] done', start: 10, end: 10 })!).value).toBe('- [x] done\n- [ ] ');
    expect(apply('- a\n- ', continueOnEnter({ value: '- a\n- ', start: 6, end: 6 })!).value).toBe('- a\n');
    expect(continueOnEnter({ value: 'plain', start: 5, end: 5 })).toBeNull();
  });

  it('keeps the indent inside a code fence', () => {
    const value = '```ts\n  if (x) {';
    expect(apply(value, continueOnEnter({ value, start: value.length, end: value.length })!).value).toBe(`${value}\n  `);
  });

  it('nests and un-nests with Tab', () => {
    expect(apply('- a\n- b', indentLines({ value: '- a\n- b', start: 4, end: 7 }, false)).value).toBe('- a\n  - b');
    expect(apply('- a\n  - b', indentLines({ value: '- a\n  - b', start: 6, end: 9 }, true)).value).toBe('- a\n- b');
  });

  it('inserts blocks on their own lines with the part to fill in selected', () => {
    const code = apply('before', insertBlock({ value: 'before', start: 6, end: 6 }, 'code'));
    expect(code).toEqual({ value: 'before\n```ts\n\n```', selected: 'ts' });
    expect(apply('', insertLink({ value: '', start: 0, end: 0 })).selected).toBe('https://');
    expect(apply('hot', colorSpan({ value: 'hot', start: 0, end: 3 }, 'rose')).value).toBe('[hot]{.rose}');
    expect(apply('[hot]{.rose}', colorSpan({ value: '[hot]{.rose}', start: 0, end: 12 }, 'teal')).value).toBe('[hot]{.teal}');
  });
});

describe('Agents style labels', () => {
  const build = (raw: Record<string, unknown>): DraftDocument => {
    const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_richtext000').text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.document;
  };
  const base = () =>
    build({
      nodes: [{ id: 'api', type: 'api', label: 'Orders API' }],
      notes: [{ id: 'sla', kind: 'label', about: 'api', attach: false, text: '### SLA\n| Endpoint | p99 |\n| --- | --- |\n| POST | 120 ms |', style: { background: 'card', font: 'mono', color: 'blue', role: 'heading' } }],
    });

  it('creates a free label with its style and reads the style back', () => {
    const file = base();
    expect(file.nodes.find((n) => n.id === 'sla')).toMatchObject({ type: 'text', textBackground: 'card', textFont: 'mono', accent: 'blue', textRole: 'heading' });
    const notes = readDiagram(file, {}, 'r:1', 'd_richtext000').notes as Record<string, unknown>[];
    expect(notes.find((n) => n.id === 'sla')).toMatchObject({ kind: 'label', color: 'blue', style: { background: 'card', font: 'mono', role: 'heading' } });
  });

  it('changes named style fields, turns one off with "none", and clears it all with null', () => {
    const changed = applyUpdate(base(), [], [{ op: 'update', id: 'sla', set: { style: { font: 'serif', background: 'none', bold: true } } }], undefined).file;
    expect(changed.nodes.find((n) => n.id === 'sla')).toMatchObject({ textFont: 'serif', textBold: true, textRole: 'heading' });
    expect(changed.nodes.find((n) => n.id === 'sla')!.textBackground).toBeUndefined();
    const plain = applyUpdate(changed, [], [{ op: 'update', id: 'sla', set: { style: null } }], undefined).file.nodes.find((n) => n.id === 'sla')!;
    expect([plain.textFont, plain.textBold, plain.textRole]).toEqual([undefined, undefined, undefined]);
  });

  it('refuses a style on an attached label or on a note, with the fix', () => {
    const attempt = (note: Record<string, unknown>) => {
      try {
        build({ nodes: [{ id: 'api', type: 'api', label: 'A' }], notes: [{ id: 'x', about: 'api', text: 'hi', ...note }] });
      } catch (error) {
        if (error instanceof AgentError) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(attempt({ kind: 'label', style: { font: 'serif' } }).message).toContain('attach: false');
    expect(attempt({ kind: 'note', attach: false, style: { font: 'serif' } }).message).toContain('only a note of kind "label"');
  });
});
