/**
 * The edits a Text element's format bar and shortcuts make to its Markdown source. Pure: each takes
 * the source and a selection and returns the replacement — what to replace, with what, and where the
 * selection lands — so the editor can apply it as one native, undoable text insertion.
 */

export interface SourceSelection {
  value: string;
  start: number;
  end: number;
}

export interface SourceEdit {
  /** The range of `value` being replaced. */
  from: number;
  to: number;
  insert: string;
  /** The selection afterwards, in the new value. */
  start: number;
  end: number;
}

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'code' | 'highlight';

const INLINE_MARKS: Record<InlineFormat, string> = {
  bold: '**',
  italic: '_',
  strike: '~~',
  code: '`',
  highlight: '==',
};

/**
 * Wraps the selection in `bold`/`italic`/… marks, or unwraps it when it is already wrapped (the
 * marks inside the selection, or just outside it). An empty selection inserts a pair with the caret
 * between them, ready to type into.
 */
export function toggleInline({ value, start, end }: SourceSelection, format: InlineFormat): SourceEdit {
  const mark = INLINE_MARKS[format];
  const selected = value.slice(start, end);
  // Surrounding whitespace stays outside the marks: `** bold**` is not bold in Markdown.
  const lead = /^\s*/.exec(selected)![0].length;
  const trail = /\s*$/.exec(selected.slice(lead))![0].length;
  const innerStart = start + lead;
  const innerEnd = end - trail;
  const inner = value.slice(innerStart, innerEnd);

  if (inner.length >= mark.length * 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
    const stripped = inner.slice(mark.length, inner.length - mark.length);
    return { from: innerStart, to: innerEnd, insert: stripped, start: innerStart, end: innerStart + stripped.length };
  }
  if (value.slice(innerStart - mark.length, innerStart) === mark && value.slice(innerEnd, innerEnd + mark.length) === mark) {
    return { from: innerStart - mark.length, to: innerEnd + mark.length, insert: inner, start: innerStart - mark.length, end: innerEnd - mark.length };
  }
  return {
    from: innerStart,
    to: innerEnd,
    insert: `${mark}${inner}${mark}`,
    start: innerStart + mark.length,
    end: innerEnd + mark.length,
  };
}

/** A link around the selection; with nothing selected, a placeholder for its words. */
export function insertLink({ value, start, end }: SourceSelection): SourceEdit {
  const words = value.slice(start, end) || 'link';
  const insert = `[${words}](https://)`;
  // The address is what's still missing: select it, ready to paste over.
  const urlStart = start + words.length + 3;
  return { from: start, to: end, insert, start: urlStart, end: urlStart + 'https://'.length };
}

/** Coloured words, in the diagram's palette: `[words]{.teal}`. Re-colouring replaces the colour. */
export function colorSpan({ value, start, end }: SourceSelection, color: string): SourceEdit {
  const selected = value.slice(start, end);
  const existing = /^\[((?:\\.|[^[\]\\])+)\]\{\.[a-z]+\}$/.exec(selected);
  const words = existing ? existing[1]! : selected || 'text';
  const insert = color === 'neutral' ? words : `[${words}]{.${color}}`;
  const offset = color === 'neutral' ? 0 : 1;
  return { from: start, to: end, insert, start: start + offset, end: start + offset + words.length };
}

export type LineFormat = 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'task' | 'quote';

const LINE_PREFIX = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)?/;

const PREFIXES: Record<LineFormat, (index: number) => string> = {
  h1: () => '# ',
  h2: () => '## ',
  h3: () => '### ',
  bullet: () => '- ',
  number: (index) => `${index + 1}. `,
  task: () => '- [ ] ',
  quote: () => '> ',
};

function lineStartAt(value: string, position: number): number {
  // lastIndexOf clamps a negative position to zero, which would skip a leading newline when
  // formatting the empty first line. The resulting reversed range duplicated that newline.
  return position === 0 ? 0 : value.lastIndexOf('\n', position - 1) + 1;
}

function lineRange(value: string, start: number, end: number): { from: number; to: number } {
  const from = lineStartAt(value, start);
  // A selection ending at the very start of a line doesn't include that line.
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const next = value.indexOf('\n', last);
  return { from, to: next === -1 ? value.length : next };
}

/**
 * Turns the selected lines into headings, list items, tasks or a quote — or, when every one of them
 * already is that, back into plain lines. Indentation is kept, and an existing prefix is replaced
 * rather than stacked (a bullet becomes a task, not `- - [ ]`).
 */
export function toggleLines({ value, start, end }: SourceSelection, format: LineFormat): SourceEdit {
  const { from, to } = lineRange(value, start, end);
  const lines = value.slice(from, to).split('\n');
  const prefixOf = (line: string) => LINE_PREFIX.exec(line)![2] ?? '';
  const matches = (line: string, index: number) => {
    const prefix = prefixOf(line);
    if (format === 'number') return /^\d+[.)] $/.test(prefix);
    if (format === 'bullet') return /^[-*+] $/.test(prefix);
    if (format === 'task') return /^[-*+] \[[ xX]\] $/.test(prefix);
    if (format === 'quote') return prefix.startsWith('>');
    return prefix === PREFIXES[format](index);
  };
  const removing = lines.some(matches) && lines.every((line, index) => line.trim() === '' || matches(line, index));
  let counter = 0;
  const next = lines.map((line) => {
    const match = LINE_PREFIX.exec(line)!;
    const indent = match[1] ?? '';
    const rest = line.slice(match[0].length);
    if (removing) return indent + rest;
    if (line.trim() === '' && lines.length > 1) return line;
    return indent + PREFIXES[format](counter++) + rest;
  });
  const insert = next.join('\n');
  // A single line keeps its caret where it was, moved by however much its prefix changed.
  if (lines.length === 1) {
    const delta = insert.length - (to - from);
    const caret = Math.max(from, Math.min(from + insert.length, start + delta));
    return { from, to, insert, start: caret, end: Math.max(caret, Math.min(from + insert.length, end + delta)) };
  }
  return { from, to, insert, start: from, end: from + insert.length };
}

/** A block inserted on its own line(s): a fenced code block, a table, a callout, a divider. */
export type BlockInsert = 'code' | 'table' | 'callout' | 'rule';

export function insertBlock({ value, start, end }: SourceSelection, block: BlockInsert): SourceEdit {
  const selected = value.slice(start, end);
  const before = start === 0 || value[start - 1] === '\n' ? '' : '\n';
  const after = end === value.length || value[end] === '\n' ? '' : '\n';
  let body: string;
  let focus: [number, number];
  switch (block) {
    case 'code': {
      const code = selected || '';
      body = `\`\`\`ts\n${code}\n\`\`\``;
      // The language is the first thing to set; with code already selected, the code stays selected.
      focus = selected ? [6, 6 + code.length] : [3, 5];
      break;
    }
    case 'table':
      body = '| Column | Column |\n| --- | --- |\n| Cell | Cell |';
      focus = [2, 8];
      break;
    case 'callout': {
      const words = selected || 'Something worth knowing';
      body = `> [!NOTE]\n> ${words.split('\n').join('\n> ')}`;
      focus = [12, 12 + words.length];
      break;
    }
    case 'rule':
      body = '---\n';
      focus = [4, 4];
      break;
  }
  const insert = `${before}${body}${after}`;
  const base = start + before.length;
  return { from: start, to: end, insert, start: base + focus[0], end: base + focus[1] };
}

const CONTINUABLE = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/;

/**
 * Enter inside a list, a task list or a quote starts the next item (`3.` after `2.`, an unticked
 * box after a ticked one). Enter on an item with nothing after its marker ends the list instead,
 * the way every Markdown editor does. Inside a fenced code block, the new line keeps the indent.
 * `null`: an ordinary newline.
 */
export function continueOnEnter({ value, start, end }: SourceSelection): SourceEdit | null {
  if (start !== end) return null;
  const lineStart = lineStartAt(value, start);
  const line = value.slice(lineStart, start);

  if (insideFence(value, lineStart)) {
    const indent = /^[ \t]*/.exec(line)![0];
    if (!indent) return null;
    return { from: start, to: end, insert: `\n${indent}`, start: start + 1 + indent.length, end: start + 1 + indent.length };
  }

  const match = CONTINUABLE.exec(line);
  if (!match) return null;
  const [whole, indent = '', marker = ''] = match;
  if (line.slice(whole.length).trim() === '' && value.slice(start, value.indexOf('\n', start) === -1 ? value.length : value.indexOf('\n', start)).trim() === '') {
    // An empty item: end the list, leaving the line blank.
    return { from: lineStart, to: start, insert: '', start: lineStart, end: lineStart };
  }
  const nextMarker =
    match[3] !== undefined
      ? `${Number(match[3]) + 1}${match[4]} `
      : marker.includes('[')
        ? `${marker[0]} [ ] `
        : marker;
  const insert = `\n${indent}${nextMarker}`;
  return { from: start, to: end, insert, start: start + insert.length, end: start + insert.length };
}

/** Whether the line starting at `lineStart` is inside a Markdown fence that opened above it. */
function insideFence(value: string, lineStart: number): boolean {
  let open: string | null = null;
  for (const line of value.slice(0, lineStart).split('\n')) {
    // A list item adds its own indentation before the fence's allowed indentation. Keep it here:
    // applying a top-level three-space cap mistakes a nested code block for ordinary list text.
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const [, fence = '', rest = ''] = match;
    if (open) {
      // Literal shorter fences and the other marker are code, not a closing delimiter.
      if (fence[0] === open[0] && fence.length >= open.length && rest.trim() === '') open = null;
    } else if (fence[0] !== '`' || !rest.includes('`')) {
      open = fence;
    }
  }
  return open !== null;
}

/**
 * Tab and Shift+Tab: nest or un-nest the selected lines — list items under the item above them,
 * code a step in. A numbered item's children sit under its text, three columns in; everything else
 * moves by two.
 */
export function indentLines({ value, start, end }: SourceSelection, outdent: boolean): SourceEdit {
  const { from, to } = lineRange(value, start, end);
  const lines = value.slice(from, to).split('\n');
  let firstDelta = 0;
  let total = 0;
  const next = lines.map((line, index) => {
    const step = /^\s*\d+[.)] /.test(line) ? 3 : 2;
    let changed: string;
    if (outdent) {
      const remove = Math.min(step, /^ */.exec(line)![0].length);
      changed = line.slice(remove);
    } else {
      changed = ' '.repeat(step) + line;
    }
    const delta = changed.length - line.length;
    if (index === 0) firstDelta = delta;
    total += delta;
    return changed;
  });
  const insert = next.join('\n');
  return {
    from,
    to,
    insert,
    start: Math.max(from, start + firstDelta),
    end: Math.max(from, end + total),
  };
}
