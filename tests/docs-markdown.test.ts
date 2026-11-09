import { describe, expect, it } from 'vitest';
import {
  defaultPlacement,
  escapeAlt,
  excerptAround,
  headingsOf,
  insertImage,
  markdownImage,
  markdownPath,
  referenceLine,
  referencesTo,
} from '../src/export/docs/markdown';

/** What the desktop shell enforces before it writes: the new text is the old with one block added. */
function onlyAdds(before: string, after: string): boolean {
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix += 1;
  return after.slice(0, prefix) === before.slice(0, prefix) && after.endsWith(before.slice(prefix));
}

describe('an image reference', () => {
  it('encodes each path segment and keeps the slashes', () => {
    expect(markdownPath('diagrams/payments.svg')).toBe('diagrams/payments.svg');
    expect(markdownPath('../docs/Payment Flow (v2).svg')).toBe('../docs/Payment%20Flow%20%28v2%29.svg');
    expect(markdownPath('設計/図.svg')).toBe('%E8%A8%AD%E8%A8%88/%E5%9B%B3.svg');
    expect(markdownPath('a#b?.svg')).toBe('a%23b%3F.svg');
  });

  it('escapes what would end the alt text early', () => {
    expect(escapeAlt('Payments [v2] \\ core\n  flow')).toBe('Payments \\[v2\\] \\\\ core flow');
    expect(markdownImage('Payments / Ledger', 'diagrams/a b.svg')).toBe('![Payments / Ledger](diagrams/a%20b.svg)');
  });
});

const README = `---
title: Shop
---
# Shop

Intro text.

\`\`\`md
## Not a heading
\`\`\`

## Architecture overview

How it fits together.

### Details

More.

## Running

npm start
`;

describe('headings', () => {
  it('skips front matter and fenced code', () => {
    expect(headingsOf(README).map((heading) => `${heading.level}:${heading.text}`)).toEqual([
      '1:Shop',
      '2:Architecture overview',
      '3:Details',
      '2:Running',
    ]);
  });

  it('does not end a code block at a fence line that carries an info string', () => {
    const text = '# A\n\n```\ncode\n```js\nstill code\n```\n\n## Real\n';
    expect(headingsOf(text).map((heading) => heading.text)).toEqual(['A', 'Real']);
  });

  it('suggests a section that sounds like a diagram belongs there, else the end', () => {
    const headings = headingsOf(README);
    expect(defaultPlacement(headings)).toEqual({ kind: 'section', line: headings[1]!.line });
    expect(defaultPlacement(headingsOf('# Title\n\n## Usage\n'))).toEqual({ kind: 'end' });
  });
});

describe('adding the image', () => {
  const snippet = '![Payments](diagrams/payments.svg)';

  it('goes under the chosen heading, before the next heading of any level, and only adds', () => {
    const line = headingsOf(README)[1]!.line;
    const { text, line: at, inserted } = insertImage(README, { kind: 'section', line }, snippet);
    expect(onlyAdds(README, text)).toBe(true);
    expect(text.split('\n')[at]).toBe(snippet);
    // Under the section's own text, before its "### Details" subsection, with blank lines either side.
    expect(text).toContain(`How it fits together.\n\n${snippet}\n\n### Details`);
    expect(inserted).toBe(`${snippet}\n\n`);
  });

  it('puts an image chosen for a top heading under it, not at the end of the file', () => {
    const doc = '# Payments\n\nIntro.\n\n## Install\n\nnpm i\n';
    expect(insertImage(doc, { kind: 'section', line: 0 }, snippet).text).toBe(`# Payments\n\nIntro.\n\n${snippet}\n\n## Install\n\nnpm i\n`);
  });

  it('goes at the end, finishing an unterminated last line', () => {
    expect(insertImage('# T\n\nText', { kind: 'end' }, snippet).text).toBe(`# T\n\nText\n\n${snippet}\n`);
    expect(insertImage('# T\n\nText\n', { kind: 'end' }, snippet).text).toBe(`# T\n\nText\n\n${snippet}\n`);
    expect(insertImage('# T\n\nText\n\n', { kind: 'end' }, snippet).text).toBe(`# T\n\nText\n\n${snippet}\n`);
    expect(insertImage('', { kind: 'end' }, snippet).text).toBe(`${snippet}\n`);
  });

  it('keeps Windows line endings and every other byte', () => {
    const crlf = '# T\r\n\r\n## Design\r\nText  \r\n## Next\r\n';
    const result = insertImage(crlf, { kind: 'section', line: 2 }, snippet);
    expect(onlyAdds(crlf, result.text)).toBe(true);
    expect(result.text).toBe(`# T\r\n\r\n## Design\r\nText  \r\n\r\n${snippet}\r\n\r\n## Next\r\n`);
  });

  it('notices the picture is already referenced, however it was written', () => {
    const path = 'diagrams/Payment Flow.svg';
    expect(referencesTo('![x](diagrams/Payment%20Flow.svg)', path)).toBe(1);
    expect(referencesTo('![x](./diagrams/Payment%20Flow.svg "title")', path)).toBe(1);
    expect(referencesTo('![x](<diagrams/Payment Flow.svg>)', path)).toBe(1);
    expect(referencesTo('<img src="diagrams/Payment%20Flow.svg" width="600">', path)).toBe(1);
    expect(referencesTo('![x][d]\n\n[d]: diagrams/Payment%20Flow.svg', path)).toBe(1);
    expect(referencesTo('![x](diagrams/other.svg)', path)).toBe(0);
    // Adding it once makes a second add a no-op the panel can see.
    const once = insertImage('# Doc\n', { kind: 'end' }, markdownImage('Payments', path)).text;
    expect(referencesTo(once, path)).toBe(1);
  });

  it('recognises its own reference whatever characters the name holds, so it never adds it twice', () => {
    for (const name of ['R&D.svg', 'a+b.svg', 'x,y.svg', 'a#1.svg', 'what?.svg', 'diagrams/Q&A (v2).svg', '設計.svg']) {
      const once = insertImage('# Doc\n', { kind: 'end' }, markdownImage('X', name)).text;
      expect(referencesTo(once, name), name).toBe(1);
    }
    // A fragment or query in a hand-written reference still points at the same file.
    expect(referencesTo('![x](diagrams/a.svg#light)', 'diagrams/a.svg')).toBe(1);
  });

  it('supports several diagrams in one file', () => {
    const first = insertImage('# Doc\n', { kind: 'end' }, '![A](a.svg)').text;
    const second = insertImage(first, { kind: 'end' }, '![B](b.svg)').text;
    expect(second).toBe('# Doc\n\n![A](a.svg)\n\n![B](b.svg)\n');
    expect(referencesTo(second, 'a.svg') + referencesTo(second, 'b.svg')).toBe(2);
  });

  it('shows a few lines either side of the new one', () => {
    const { text, line } = insertImage(README, { kind: 'end' }, snippet);
    const excerpt = excerptAround(text, line);
    expect(excerpt.find((entry) => entry.inserted)?.text).toBe(snippet);
    // Back to the heading of the section it lands in, so the excerpt says where it is.
    expect(excerpt[0]!.text).toBe('## Running');
    expect(excerpt.at(-1)!.text).toBe(snippet);
  });

  it('finds the line an existing reference is on', () => {
    expect(referenceLine('# Doc\n\nText\n\n![A](a%20b.svg)\n', 'a b.svg')).toBe(4);
    expect(referenceLine('# Doc\n', 'a.svg')).toBe(-1);
  });
});
